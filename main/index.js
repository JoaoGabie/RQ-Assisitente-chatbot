

const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const dotenv = require('dotenv');
// main/index.js

const ENV_PATH = path.join(__dirname, '..', '.env');

if (fs.existsSync(ENV_PATH)) {
  dotenv.config({ path: ENV_PATH });
  console.log('🔧 .env carregado de', ENV_PATH);
} else {
  console.warn('⚠️ .env NÃO encontrado em', ENV_PATH);
}

// Agora sim: debug das variáveis JÁ carregadas
console.log('🔎 Variáveis carregadas:');
console.log('OPENROUTER_API_KEY:', process.env.OPENROUTER_API_KEY ? process.env.OPENROUTER_API_KEY.slice(0, 10) + '...' : 'MISSING');
console.log('OPENROUTER_MODEL:', process.env.OPENROUTER_MODEL || 'MISSING');
console.log('LOG_LEVEL:', process.env.LOG_LEVEL || 'MISSING');
console.log('PORT:', process.env.PORT || 'MISSING');

dotenv.config();
if (!process.env.OPENROUTER_API_KEY) {
  const rootEnv = path.join(__dirname, '..', '.env');
  if (fs.existsSync(rootEnv)) {
    dotenv.config({ path: rootEnv });
    console.log('🔧 .env carregado de', rootEnv);
  }
}

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const MODULES_DIR = path.join(__dirname, 'modules');
const modules = {};

// ----- Logger (pino + pino-pretty) -----
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const logger = pino({
  level: LOG_LEVEL,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
      ignore: 'pid,hostname',
      singleLine: false,
      messageKey: 'msg',
    },
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let restarting = false;

const startBot = async () => {
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`WA version: ${version.join('.')} ${isLatest ? '(latest)' : ''}`);

  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth'));

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    emitOwnEvents: false,
    connectTimeoutMs: 30_000,
    logger,
  });

  sock.ev.on('creds.update', saveCreds);

  // Conexão + QR
  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      console.clear();
      logger.info('📱 Escaneie o QR abaixo para conectar:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('✅ Conexão estabelecida com o WhatsApp!');
      logger.info({ user: sock.user }, '👤 Usuário conectado');
      try {
        await sock.sendMessage(sock.user.id, { text: 'RQ Assistente online ✅' });
      } catch (e) {
        logger.warn({ err: e?.message }, 'Falha ao enviar ping inicial');
      }
    }

    if (connection === 'close') {
      const boom = lastDisconnect?.error;
      const statusCode =
        boom?.output?.statusCode ??
        boom?.output?.payload?.statusCode ??
        boom?.data?.statusCode ??
        boom?.statusCode ??
        'unknown';

      logger.warn({ statusCode }, '🔌 Conexão fechada');

      if (statusCode !== DisconnectReason.loggedOut) {
        if (!restarting) {
          restarting = true;
          const waitMs = 2000;
          logger.info(`♻️ Tentando reconectar em ${waitMs} ms...`);
          await sleep(waitMs);
          restarting = false;
          startBot().catch((e) => logger.error({ err: e?.message }, 'Erro ao reiniciar'));
        }
      } else {
        logger.error('🚪 Sessão deslogada. Exclua a pasta "auth" e pareie novamente.');
      }
    }
  });

  // ----- Carregar módulos -----
  try {
    // 1) carrega PUBLIC primeiro (prioridade)
    const publicPath = path.join(MODULES_DIR, 'public.js');
    if (fs.existsSync(publicPath)) {
      delete require.cache[publicPath];
      const publicMod = require(publicPath);
      if (publicMod?.onMessage) {
        modules['public'] = publicMod;
        logger.info({ moduleName: 'public' }, '📦 Módulo carregado com prioridade');
      }
    }

    // 2) carrega os demais módulos
    const files = fs.readdirSync(MODULES_DIR);
    for (const file of files) {
      if (!file.endsWith('.js') || file === 'public.js') continue;

      const moduleName = file.replace('.js', '');
      const modulePath = path.join(MODULES_DIR, file);

      try {
        delete require.cache[modulePath];
        const mod = require(modulePath);
        if (mod?.onMessage) {
          modules[moduleName] = mod;
          logger.info({ moduleName }, '📦 Módulo carregado');
        } else {
          logger.warn({ moduleName }, '⚠️ Ignorado: não exporta onMessage');
        }
      } catch (e) {
        logger.error({ moduleName, err: e?.message }, '💥 Falha ao carregar módulo');
      }
    }
  } catch (err) {
    logger.error({ err: err?.message }, '💥 Erro ao listar módulos');
  }

  // ----- Roteamento principal -----
  sock.ev.on('messages.upsert', async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg?.message) return;

      const allowFromMe = String(process.env.ALLOW_FROM_ME || 'false').toLowerCase() === 'true';
      if (msg.key.fromMe && !allowFromMe) return;

         const jid = msg.key.remoteJid;
        // grupos no WhatsApp terminam com "@g.us"
        const isGroup = typeof jid === 'string' && jid.endsWith('@g.us');

      // chama PUBLIC primeiro
      if (modules['public']) {
        try {
          const handled = await modules['public'].onMessage(sock, msg, isGroup);
          if (handled === true) return;
        } catch (err) {
          logger.error({ moduleName: 'public', err: err?.message }, '💥 Erro no public.onMessage');
        }
      }

      // chama outros módulos
      for (const moduleName of Object.keys(modules)) {
        if (moduleName === 'public') continue;
        const mod = modules[moduleName];
        if (typeof mod.onMessage === 'function') {
          try {
            await mod.onMessage(sock, msg, isGroup);
          } catch (err) {
            logger.error({ moduleName, err: err?.message }, '💥 Erro no módulo onMessage');
          }
        }
      }
    } catch (err) {
      logger.error({ err: err?.message }, '💥 Erro ao processar mensagens');
    }
  });

  return sock;
};

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: err?.message, stack: err?.stack }, 'uncaughtException');
});

startBot().catch((err) => logger.error({ err: err?.message }, '💥 Erro fatal ao iniciar o bot'));
