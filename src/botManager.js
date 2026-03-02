const TelegramBot = require("node-telegram-bot-api");
const { PrismaClient } = require("@prisma/client");
const path = require("path");
const fs = require("fs");

const prisma = new PrismaClient();
const botsAtivos = new Map();

function log(nome, msg) {
  console.log(`[${new Date().toLocaleTimeString("pt-BR")}] [${nome}] ${msg}`);
}

function tempoAleatorio(minMin, maxMin) {
  const min = minMin * 60 * 1000;
  const max = maxMin * 60 * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function enviarApresentacao(bot, config) {
  try {
    const texto = config.apresentacao || `Olá! Sou ${config.nome}. Me chame no privado!`;
    if (config.fotoPerfil) {
      const fotoPath = path.join(__dirname, "../public/uploads", config.fotoPerfil);
      if (fs.existsSync(fotoPath)) {
        await bot.sendPhoto(config.grupoId, fotoPath, { caption: texto });
        log(config.nome, "Foto + apresentação enviada");
        return;
      }
    }
    await bot.sendMessage(config.grupoId, texto);
    log(config.nome, "Apresentação enviada");
  } catch (err) {
    log(config.nome, `Erro: ${err.message}`);
  }
}

function agendarProximo(bot, config) {
  const tempo = tempoAleatorio(config.intervalMin, config.intervalMax);
  log(config.nome, `Próxima mensagem em ${Math.round(tempo / 60000)} min`);
  return setTimeout(async () => {
    await enviarApresentacao(bot, config);
    await prisma.bot.update({ where: { id: config.id }, data: { ultimaMsg: new Date() } }).catch(() => {});
    const inst = botsAtivos.get(config.id);
    if (inst) inst.timer = agendarProximo(bot, config);
  }, tempo);
}

function enviarPasso(bot, chatId, passo) {
  const opts = {};
  // botoes pode vir como string (SQLite) ou array
  const botoes = typeof passo.botoes === "string"
    ? JSON.parse(passo.botoes)
    : (passo.botoes || []);

  if (passo.tipo === "botoes" && botoes.length) {
    opts.reply_markup = {
      inline_keyboard: botoes.map(b => [
        { text: b.texto, callback_data: JSON.stringify({ proximoPasso: b.proximoPasso }) },
      ]),
    };
  }
  bot.sendMessage(chatId, passo.mensagem, opts);
}

async function configurarFunil(bot, config) {
  let passos = [];
  if (config.funilId) {
    const funil = await prisma.funil.findUnique({
      where: { id: config.funilId },
      include: { passos: { orderBy: { ordem: "asc" } } },
    });
    if (funil) passos = funil.passos;
  }
  const primeiro = passos[0] || null;

  bot.onText(/\/start/, (msg) => {
    if (msg.chat.type !== "private") return;
    if (primeiro) enviarPasso(bot, msg.chat.id, primeiro);
    else bot.sendMessage(msg.chat.id, `Olá! Sou ${config.nome}. Como posso ajudar?`);
  });

  bot.on("callback_query", (query) => {
    try {
      const dados = JSON.parse(query.data);
      if (dados.proximoPasso !== undefined) {
        const passo = passos.find(p => p.ordem === dados.proximoPasso);
        if (passo) {
          bot.answerCallbackQuery(query.id);
          enviarPasso(bot, query.message.chat.id, passo);
        }
      }
    } catch (_) {}
  });

  bot.on("message", (msg) => {
    if (msg.chat.type !== "private" || msg.text?.startsWith("/")) return;
    if (primeiro) enviarPasso(bot, msg.chat.id, primeiro);
    else bot.sendMessage(msg.chat.id, `Olá! Sou ${config.nome}. Use /start para começar.`);
  });
}

async function iniciarBot(config) {
  if (botsAtivos.has(config.id)) await pararBot(config.id);
  try {
    const bot = new TelegramBot(config.token, { polling: true });
    log(config.nome, "Iniciado!");
    await configurarFunil(bot, config);
    bot.on("polling_error", (err) => log(config.nome, `Polling error: ${err.message}`));
    const timer = agendarProximo(bot, config);
    botsAtivos.set(config.id, { bot, timer, nome: config.nome });
    return true;
  } catch (err) {
    log(config.nome, `Falha: ${err.message}`);
    return false;
  }
}

async function pararBot(botId) {
  const inst = botsAtivos.get(botId);
  if (!inst) return;
  clearTimeout(inst.timer);
  try { await inst.bot.stopPolling(); } catch (_) {}
  botsAtivos.delete(botId);
  log(inst.nome, "Parado.");
}

async function iniciarTodosBots() {
  const bots = await prisma.bot.findMany({ where: { ativo: true } });
  log("SISTEMA", `Iniciando ${bots.length} bots...`);
  for (const b of bots) await iniciarBot(b);
  log("SISTEMA", "Prontos!");
}

function getStatus() {
  const s = {};
  for (const [id, inst] of botsAtivos.entries()) s[id] = { online: true, nome: inst.nome };
  return s;
}

function isBotAtivo(id) { return botsAtivos.has(id); }

module.exports = { iniciarBot, pararBot, iniciarTodosBots, getStatus, isBotAtivo };
