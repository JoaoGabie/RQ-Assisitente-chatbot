// modules/midia-bot.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage, getContentType } = require('@whiskeysockets/baileys');

const SERVER = process.env.BACKEND_URL || 'http://127.0.0.1:8000'; // use .env se quiser
const MEDIA_DIR = path.join(__dirname, '..', 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

module.exports = {
  name: 'midia-bot',
  // Pode ser boolean ou array; seu loader só checa truthy.
  requires: ['health'],

  /**
   * Handler principal
   * @param {import('@whiskeysockets/baileys').WASocket} sock
   * @param {*} msg
   * @param {boolean} isGroup
   */
  onMessage: async (sock, msg, isGroup) => {
    if (!msg?.message) return;

    // Em grupo, só responde se for mencionado
    const proceed = !isGroup || (isGroup && await isBotMentioned(sock, msg));
    if (!proceed) return;

    // Descobre o tipo de conteúdo
    const ctype = getContentType(msg.message); // ex: 'audioMessage', 'imageMessage', 'documentMessage', etc.

    // Aceitar apenas áudio (audioMessage) ou documento cujo mimetype seja audio/*
    const audioNode =
      msg.message?.audioMessage ||
      (msg.message?.documentMessage?.mimetype?.startsWith('audio/')
        ? msg.message.documentMessage
        : null);

    if (!audioNode) {
      // se quiser responder quando não for áudio, descomente:
      // await sock.sendMessage(msg.key.remoteJid, { text: '❌ Envie apenas arquivos de áudio (mp3, wav, flac, aac, ogg, m4a).' });
      return;
    }

    try {
      // Baixa o conteúdo como Buffer
      const buffer = await downloadToBuffer(audioNode, 'audio');

      // Descobre a extensão a partir do mimetype (ex.: audio/ogg; codecs=opus)
      const rawMime = (audioNode.mimetype || 'audio/unknown').toLowerCase();
      const mimeMain = rawMime.split(';')[0];            // "audio/ogg"
      const ext = mimeMain.split('/')[1] || 'bin';       // "ogg"

      // Permitir formatos comuns de áudio
      const allowed = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'oga', 'opus']);
      if (!allowed.has(ext)) {
        await sock.sendMessage(msg.key.remoteJid, {
          text: '❌ Só aceito arquivos de áudio (mp3, wav, flac, aac, ogg, m4a, opus).',
        });
        return;
      }

      // Gera ID curto e salva
      const id = 'A' + Date.now().toString().slice(-6);
      const file = path.join(MEDIA_DIR, `${id}.${ext}`);
      fs.writeFileSync(file, buffer);
      console.log(`💾 Arquivo salvo: ${file} (ID ${id})`);

      // Notifica backend
      await axios.post(`${SERVER}/library/import`, { id, file, label: null });

      // Resposta
      await sock.sendMessage(msg.key.remoteJid, {
        text:
          `📥 Áudio recebido (${ext}). ID: ${id}\n` +
          `Defina rótulo: rotulo ${id} <texto>\n` +
          `Tocar: tocar ${id}`,
      });
    } catch (e) {
      console.error('[midia-bot] erro ao processar áudio:', e?.response?.data || e.message);
      await sock.sendMessage(msg.key.remoteJid, { text: '⚠️ Falha ao processar o áudio.' });
    }
  },
};

// Utilitários
async function isBotMentioned(sock, msg) {
  const myJid = sock.user?.id;
  const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  return Array.isArray(mentions) && myJid ? mentions.includes(myJid) : false;
}

async function downloadToBuffer(messageNode, type /* 'audio' | 'image' | ... */) {
  const stream = await downloadContentFromMessage(messageNode, type);
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer;
}
