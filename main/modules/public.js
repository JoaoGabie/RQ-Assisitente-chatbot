// modules/public.js
let _client = null;

module.exports = {
  name: 'public',

  onMessage: async (sock, msg, isGroup) => {
    const jid = msg.key?.remoteJid;
    try {
      // responde sempre em DM; em grupo só se mencionado
      const proceed = !isGroup || (isGroup && await isBotMentioned(sock, msg));
      if (!proceed) return false;

      const text = extractText(msg);
      if (!text || /^[!/.]/.test(text.trim())) return false;

      if (!process.env.OPENROUTER_API_KEY) {
        await sock.sendMessage(jid, { text: '⚠️ IA desativada: defina OPENROUTER_API_KEY no .env.' });
        return true;
      }

      // 1) presença "digitando…"
      const typing = startTypingLoop(sock, jid);

      // 2) reaction temporária na MENSAGEM DO USUÁRIO (não cria bolha nova)
      await safeReact(sock, msg.key, '⌛');

      // 3) chama IA
      const raw = await askOpenRouter(text);

      // 4) para "digitando…" e remove reaction
      typing.stop();
      await safeReact(sock, msg.key, ''); // vazio = remove reaction

      // 5) limpa e envia resposta sem header/rodapé
      const clean = sanitize(raw);
      await sock.sendMessage(jid, { text: clean || '⚠️ (resposta vazia)' });

      return true;
    } catch (e) {
      // para presença e tenta remover reaction
      try { await sock.sendPresenceUpdate('paused', msg.key.remoteJid); } catch {}
      try { await safeReact(sock, msg.key, ''); } catch {}

      const status = e?.response?.status;
      const data = e?.response?.data;
      const name = e?.name;
      const code = e?.code;
      console.error('[public] erro:', { status, name, code, data: data || e.message });

      if (status === 401 || status === 403) {
        await sock.sendMessage(msg.key.remoteJid, { text: '🔒 Sem permissão (401/403). Verifique a OPENROUTER_API_KEY / modelo.' });
      } else if (status === 429) {
        await sock.sendMessage(msg.key.remoteJid, { text: '⏳ Limite de uso (429). Tente novamente em alguns minutos.' });
      } else if (name === 'AbortError' || code === 'ABORT_ERR') {
        await sock.sendMessage(msg.key.remoteJid, { text: '⌛ Tempo esgotado (timeout). Tente de novo.' });
      } else {
        await sock.sendMessage(msg.key.remoteJid, { text: '⚠️ Problema ao falar com a IA agora. Tente novamente.' });
      }
      return true;
    }
  },
};

/* ================= Helpers ================= */

function extractText(msg) {
  const m = msg?.message;
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.documentMessage?.caption ||
    m?.ephemeralMessage?.message?.extendedTextMessage?.text ||
    ''
  );
}

async function isBotMentioned(sock, msg) {
  const myJid = sock.user?.id;
  const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  return Array.isArray(mentions) && myJid ? mentions.includes(myJid) : false;
}

// presença “digitando…”
function startTypingLoop(sock, jid) {
  let t = null;
  const tick = () => sock.sendPresenceUpdate('composing', jid).catch(() => {});
  tick();
  t = setInterval(tick, 6000);
  return {
    stop: () => {
      if (t) clearInterval(t);
      sock.sendPresenceUpdate('paused', jid).catch(() => {});
    }
  };
}

// reaction segura (emoji) na mensagem do usuário; '' remove
async function safeReact(sock, key, emoji) {
  try {
    if (!key?.id) return;
    await sock.sendMessage(key.remoteJid, { react: { text: emoji || '', key } });
  } catch (e) {
    // ignora erro de reaction
  }
}

// limpeza de texto: remove <s>, controle, “S” soltos etc.
function sanitize(str = '') {
  let s = String(str);

  // remove tags HTML soltas <s>...</s>
  s = s.replace(/<\/?s>/gi, '');

  // remove caracteres de controle (menos \n \t)
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');

  // colapsa múltiplas quebras
  s = s.replace(/\n{3,}/g, '\n\n');

  // remove "S" isolado no topo
  s = s.replace(/^[sS]\s*[\r\n]+/, '');

  // tira espaços estranhos nas bordas
  s = s.trim();

  return s;
}

/* ============ OpenRouter via openai ============ */

async function getClient() {
  if (_client) return _client;
  const { default: OpenAI } = await import('openai');
  _client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      'HTTP-Referer': process.env.OPENROUTER_REFERRER || 'http://localhost',
      'X-Title': process.env.OPENROUTER_TITLE || 'RQ Assistente',
    },
  });
  return _client;
}

const MODEL = process.env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct:free';

async function askOpenRouter(userText) {
  const client = await getClient();

  const systemPrompt =
    'Você é o "RQ Assistente (Público)". Responda com clareza e objetividade. Seja breve.';

  // timeout total 20s
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), 20_000);

  try {
    const c = await client.chat.completions.create(
      {
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        max_tokens: 300,
        temperature: 0.4,
      },
      { signal: ac.signal }
    );
    return c.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(kill);
  }
}
