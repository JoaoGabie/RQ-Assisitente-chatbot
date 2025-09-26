// ====== Imports e setup ======
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

const SERVER = 'http://127.0.0.1:8000';
const ALLOWED_CHAT = null; // se quiser restringir a um chat ID
const MEDIA_DIR = path.join(__dirname, '..', 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const client = new Client({ authStrategy: new LocalAuth() });

// ====== Flags/Helpers ======
const REQUIRE_PREFIX_IN_GROUP = true;               // Em grupo só responde quando mencionado
const DM_HELP_COOLDOWN_MS     = 12 * 60 * 60 * 1000;
const dmHelpMemory = new Map();                     // userId -> timestamp
const pending = new Map();                          // chatId -> [results]
let MY_WID = null;                                  // id do próprio bot (wid serializado)

// ====== Eventos básicos ======
client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('📱 Escaneia o QR pra logar no WhatsApp Web');
});
client.on('authenticated', () => console.log('🔐 Authenticated'));
client.on('ready', () => {
  console.log('✅ Client ready');
  try {
    // Ex.: '557199999999@c.us'
    MY_WID = client.info?.wid?._serialized || null;
    console.log('🤖 My WID:', MY_WID);
  } catch (e) {
    console.log('⚠️ Não consegui ler MY_WID:', e);
  }
});
client.on('auth_failure', m => console.log('❌ Auth failure:', m));
client.on('disconnected', r => console.log('🔌 Disconnected:', r));
client.on('change_state', s => console.log('🔄 State:', s));
client.on('loading_screen', (p,msg) => console.log('⏳ Loading:', p, msg||''));

// ====== Utils ======
function isUrl(s){ return /^https?:\/\//i.test(s || ''); }
function isLocalId(s){ s=(s||'').trim(); return /^#?\d{1,4}$/.test(s) || /^[A-Za-z]\d{3,}$/.test(s); }

// Parser “natural” para DM (sem @bot)
function parseDmIntent(text) {
  const m = (text || '').trim();
  if (!m) return null;

  const vol = m.match(/\bvolume\s+(\d{1,3})\b/i);
  if (vol) return { name: 'volume', rest: vol[1] };

  if (/^(play|tocar|soltar)\b/i.test(m)) {
    const rest = m.replace(/^(play|tocar|soltar)\b/i, '').trim();
    return { name: 'tocar', rest };
  }

  if (/^(pause|pausar|parar)\b/i.test(m)) return { name: 'pause', rest: '' };
  if (/^(pular|next|próxima|proxima)\b/i.test(m)) return { name: 'pular',  rest: '' };
  if (/^(fila|queue)\b/i.test(m))               return { name: 'fila',   rest: '' };
  if (/^(limpar|clear)\b/i.test(m))             return { name: 'limpar', rest: '' };
  if (/^(ajuda|help)\b/i.test(m))               return { name: 'ajuda',  rest: '' };
  if (/^rotulo\s+/i.test(m)) {
    const [_, ...tail] = m.split(/\s+/);
    return { name: 'rotulo', rest: tail.join(' ') };
  }

  if (isUrl(m)) return { name: 'tocar', rest: m }; // URL direta
  return null;
}

// Grupo: detectar menção real ao bot
async function isBotMentioned(msg) {
  try {
    if (!MY_WID) return false;
    const mentions = await msg.getMentions(); // array Contacts
    return mentions.some(c => (c.id?._serialized) === MY_WID);
  } catch (e) {
    console.log('⚠️ getMentions falhou:', e);
    return false;
  }
}

// Remove menções no início da mensagem (ex.: "@Fulano @Bot comando ...")
function stripLeadingMentions(body) {
  let m = (body || '').trim();
  return m.replace(/^(@\S+\s*)+/, '').trim();
}

// ====== Listener principal ======
client.on('message', async msg => {
  try {
    console.log(`📩 De ${msg.from}: "${msg.body}"`);

    if (ALLOWED_CHAT && msg.from !== ALLOWED_CHAT) {
      console.log(`🚫 Ignorado (chat não autorizado: ${msg.from})`);
      return;
    }

    const chat = await msg.getChat();
    const isGroup = chat.isGroup;

    // ===== Upload de mídia (áudio) =====
    // DM: aceita sem menção | Grupo: só se mencionar o bot
    if (msg.hasMedia) {
      const proceed = !isGroup || (isGroup && await isBotMentioned(msg));
      if (proceed) {
        console.log('📥 Recebido arquivo de mídia');
        const media = await msg.downloadMedia();
        const ext = (media.mimetype.split('/')[1] || '').toLowerCase();
        if (!/^(mp3|wav|flac|aac|ogg|m4a)$/.test(ext)) {
          await msg.reply('❌ Só aceito arquivos de áudio (mp3, wav, flac, aac, ogg, m4a).');
          return;
        }
        const id = 'A' + Date.now().toString().slice(-6);
        const file = path.join(MEDIA_DIR, `${id}.${ext}`);
        fs.writeFileSync(file, Buffer.from(media.data, 'base64'));
        console.log(`💾 Arquivo salvo: ${file} (ID ${id})`);
        await axios.post(`${SERVER}/library/import`, { id, file, label: null });
        await msg.reply(
          `📥 áudio recebido (${ext}). ID: ${id}\n` +
          `Defina rótulo: rotulo ${id} <texto>\n` +
          `Tocar: tocar ${id}`
        );
        return;
      }
    }

    // ===== Seleção por número / sair (precisa vir ANTES do parsing) =====
    {
      const raw = (msg.body || '').trim();
      const isNumberOnly = /^\d+$/.test(raw);
      const isExit       = /^sair$/i.test(raw);

      if (pending.has(msg.from) && (isNumberOnly || isExit)) {
        const list = pending.get(msg.from);

        if (isExit) {
          pending.delete(msg.from);
          await msg.reply('✅ Pesquisa cancelada.\nDica: use *tocar <link do YouTube>* para tocar um link direto.');
          return;
        }

        const idx = parseInt(raw, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= list.length) {
          await msg.reply('Índice inválido. Digite um número da lista ou *sair* para cancelar.');
          return;
        }

        const item = list[idx];
        try {
          await axios.post(`${SERVER}/yt/play`, { video_id: item.video_id });
          pending.delete(msg.from);
          await msg.reply(`▶️ ${item.title} — ${item.channel}`);
        } catch (e) {
          console.error('Erro ao tocar por número:', e);
          await msg.reply('❌ Não consegui iniciar a reprodução.');
        }
        return;
      }
    }

    // ===== Parsing de comandos =====
    let c = null;

    if (isGroup && REQUIRE_PREFIX_IN_GROUP) {
      // Grupo: só responde se o bot for mencionado
      const mentioned = await isBotMentioned(msg);
      if (!mentioned) {
        console.log('ℹ️ Grupo: bot não foi mencionado → ignorado');
        return;
      }
      // Remove menções e interpreta o primeiro token como comando
      const cleaned = stripLeadingMentions(msg.body);
      const parts = (cleaned || '').split(/\s+/);
      const name = (parts.shift() || '').toLowerCase();
      c = { name, rest: parts.join(' ') };
      if (!c.name) {
        await msg.reply('👋 Me mencionou? Envie um comando. Ex.: *tocar <termo>*');
        return;
      }
    } else {
      // DM: aceita sem @bot (parser natural) e também aceita @bot se usar
      c = parseDmIntent(msg.body);
      if (!c) {
        const last = dmHelpMemory.get(msg.from) || 0;
        const now  = Date.now();
        if (now - last > DM_HELP_COOLDOWN_MS) {
          dmHelpMemory.set(msg.from, now);
          await msg.reply(
            "👋 Olá! Eu sou o RQ Assistente.\n" +
            "Aqui no privado você pode falar *sem @bot*.\n\n" +
            "Exemplos:\n" +
            "- *tocar <link/termo/ID>*\n" +
            "- *volume 50*\n" +
            "- *pular* | *pause* | *fila* | *limpar*\n" +
            "- *ajuda* para ver tudo\n"
          );
        }
        return;
      }
    }

    console.log(`⚙️ Comando: ${c.name} | Args: ${c.rest || ''}`);

    // ===== Execução =====
    if (c.name === 'ajuda' || c.name === 'help') {
      return msg.reply(
        `📖 *Comandos:*\n` +
        `tocar <url|#id|texto>\n` +
        `Após a busca: *digite o número* (1–5) ou *sair*\n` +
        `soltar (ou play/pause)\n` +
        `pular\n` +
        `volume <0-100>\n` +
        `fila\n` +
        `limpar\n` +
        `rotulo <ID> <texto>`
      );
    }

    if (c.name === 'rotulo') {
      const [code, ...rest] = (c.rest || '').split(/\s+/);
      const label = (rest.join(' ') || '').trim();
      if (!code || !label) return msg.reply('Use: rotulo <ID> <rótulo>');
      await axios.post(`${SERVER}/library/label`, null, { params: { code, label }});
      return msg.reply(`✅ rótulo de ${code} atualizado`);
    }

    if (c.name === 'tocar' && c.rest) {
      const q = c.rest.trim();

      if (isUrl(q)) {
        const r = await axios.post(`${SERVER}/queue`, { query: q, requested_by: msg.author || msg.from });
        if (!r.data.ok) return msg.reply('❌ não consegui tocar (confirmação requerida).');
        return msg.reply('▶️ streaming...');
      }

      if (isLocalId(q)) {
        const s = await axios.post(`${SERVER}/library/search`, { query: q, limit: 1 });
        if (!s.data.results.length) return msg.reply('ID não encontrado.');
        await axios.post(`${SERVER}/queue/by-id`, { db_id: s.data.results[0].db_id });
        return msg.reply(`▶️ ${s.data.results[0].title}`);
      }

      // Aviso de latência antes da busca
      await msg.reply('🔎 Pesquisando no YouTube…');

      const find = await axios.post(`${SERVER}/yt/search`, { query: q, limit: 5 });
      if (!find.data.ok || !find.data.results.length) {
        return msg.reply(
          '❌ Nada encontrado.\n' +
          'Dica: envie *tocar <link do YouTube>* para tocar um link direto.'
        );
      }

      pending.set(msg.from, find.data.results);
      const linhas = find.data.results
        .map((x,i)=>`${i+1}. ${x.title} — ${x.channel} [${x.duration}]`)
        .join('\n');

      return msg.reply(
        `Encontrei:\n${linhas}\n\n` +
        `*Digite apenas o número* da música desejada.\n` +
        `Se não encontrou, digite *sair*.\n` +
        `Dica: use *tocar <link do YouTube>* para tocar um link direto.`
      );
    }

    if (['soltar','play','pause'].includes(c.name)) {
      await axios.post(`${SERVER}/play`);
      return msg.reply('⏯️ play/pause');
    }

    if (c.name === 'pular' || c.name === 'next') {
      await axios.post(`${SERVER}/next`);
      return msg.reply('⏭️ próxima');
    }

    if (c.name === 'volume') {
      const v = parseInt((c.rest||''),10);
      if (isNaN(v)) return msg.reply('Use: volume 0-100');
      // mantém POST com params, como no teu backend
      await axios.post(`${SERVER}/volume`, null, { params:{ value:v } });
      return msg.reply(`🔊 volume ${v}%`);
    }

    if (c.name === 'fila') {
      const r = await axios.get(`${SERVER}/queue`);
      const linhas = (r.data.playlist||[])
        .map(it => `${it.current?'▶️':'•'} ${it.index}. ${it.filename}`)
        .slice(0,10)
        .join('\n');
      return msg.reply(linhas || 'fila vazia');
    }

    if (c.name === 'limpar') {
      await axios.post(`${SERVER}/queue/clear`);
      return msg.reply('🧹 fila limpa');
    }

    // Fallback
    await msg.reply(
      `Comandos: tocar <url|#id|texto> | após a busca *número* (1–5) ou *sair* | ` +
      `soltar | pular | volume <0-100> | fila | limpar | rotulo <ID> <texto>`
    );

  } catch (e) {
    console.error('💥 Erro ao processar comando:', e);
    try { await msg.reply('❌ erro ao processar comando'); } catch {}
  }
});

client.initialize();
