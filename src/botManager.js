const TelegramBot = require("node-telegram-bot-api");
const { PrismaClient } = require("@prisma/client");
const path = require("path");

const prisma = new PrismaClient();
const botsAtivos = new Map();

function log(nome, msg) {
  console.log(`[${new Date().toLocaleTimeString("pt-BR")}] [${nome}] ${msg}`);
}

// ============================================================
// CRONOGRAMA — 40+ msgs/dia entre 06h e 01h
// Pico noturno a partir das 18h
// ============================================================

// Retorna os slots de horário do dia em minutos desde meia-noite
function gerarSlotsHoje() {
  const slots = [];

  // Manhã 06h-12h: 8 posts, ~1 a cada 45min
  for (let i = 0; i < 8; i++) {
    const base = 360 + i * 45; // começa às 360min (06h00)
    slots.push(base + Math.floor(Math.random() * 20) - 10);
  }

  // Tarde 12h-18h: 10 posts, ~1 a cada 36min
  for (let i = 0; i < 10; i++) {
    const base = 720 + i * 36;
    slots.push(base + Math.floor(Math.random() * 20) - 10);
  }

  // Noite 18h-01h: 22 posts, ~1 a cada 19min
  for (let i = 0; i < 22; i++) {
    const base = 1080 + i * 19;
    slots.push(base + Math.floor(Math.random() * 15) - 7);
  }

  return slots.sort((a, b) => a - b);
}

// Converte minutos desde meia-noite para ms até aquele horário hoje
function msAteSlot(minutos) {
  const agora = new Date();
  const hoje = new Date();
  hoje.setHours(Math.floor(minutos / 60), minutos % 60, 0, 0);

  // Se o slot já passou hoje, agenda para amanhã
  if (hoje <= agora) hoje.setDate(hoje.getDate() + 1);

  return hoje.getTime() - agora.getTime();
}

// Seleciona uma mídia aleatória de uma categoria
async function getMidiaAleatoria(botId) {
  const categorias = ["apresentacao", "rotina", "interacao", "chamada_pvt"];
  const categoria = categorias[Math.floor(Math.random() * categorias.length)];

  const midias = await prisma.midia.findMany({ where: { botId, categoria } });
  if (!midias.length) return null;

  return midias[Math.floor(Math.random() * midias.length)];
}

// Substitui variáveis no texto
function resolverTexto(texto, bot) {
  if (!texto) return "";
  return texto
    .replace(/{nome}/g, bot.nome)
    .replace(/{idade}/g, bot.idade)
    .replace(/{cidade}/g, bot.cidade);
}

// Envia uma mídia no grupo
async function postarNoGrupo(bot, config) {
  const midia = await getMidiaAleatoria(config.id);
  if (!midia) {
    log(config.nome, "Sem mídias cadastradas, pulando slot");
    return;
  }

  const texto = resolverTexto(midia.legenda, config);

  try {
    if (midia.tipo === "texto") {
      await bot.sendMessage(config.grupoId, texto);
    } else if (midia.tipo === "foto" && midia.url) {
      await bot.sendPhoto(config.grupoId, midia.url, { caption: texto });
    } else if (midia.tipo === "video" && midia.url) {
      await bot.sendVideo(config.grupoId, midia.url, { caption: texto });
    } else if (midia.tipo === "audio" && midia.url) {
      await bot.sendAudio(config.grupoId, midia.url, { caption: texto });
    }

    await prisma.bot.update({
      where: { id: config.id },
      data: { ultimaMsg: new Date() },
    }).catch(() => {});

    log(config.nome, `Postou no grupo [${midia.categoria}/${midia.tipo}]`);
  } catch (err) {
    log(config.nome, `Erro ao postar: ${err.message}`);
  }
}

// ============================================================
// FUNIL DO PRIVADO
// ============================================================

async function processarMensagemPrivada(bot, msg, config) {
  const telegramId = String(msg.chat.id);

  if (!config.funilId) {
    bot.sendMessage(msg.chat.id, resolverTexto(`Oi! Sou a {nome}, de {cidade}. Como vai?`, config));
    return;
  }

  const funil = await prisma.funil.findUnique({
    where: { id: config.funilId },
    include: { passos: { orderBy: { ordem: "asc" } } },
  });

  if (!funil || !funil.passos.length) return;

  // Busca ou cria conversa
  let conversa = await prisma.conversa.findUnique({
    where: { botId_telegramId: { botId: config.id, telegramId } },
  });

  if (!conversa) {
    conversa = await prisma.conversa.create({
      data: { botId: config.id, telegramId, passoAtual: 0 },
    });
  }

  const passo = funil.passos.find(p => p.ordem === conversa.passoAtual);
  if (!passo) {
    // Chegou ao fim do funil, reinicia
    await prisma.conversa.update({
      where: { id: conversa.id },
      data: { passoAtual: 0, atualizadoEm: new Date() },
    });
    return;
  }

  // Aplica delay simulando digitação
  if (passo.delay > 0) {
    await bot.sendChatAction(msg.chat.id, "typing");
    await new Promise(r => setTimeout(r, passo.delay * 1000));
  }

  // Envia mídia se houver
  if (passo.mediaUrl) {
    const legenda = resolverTexto(passo.texto, config);
    try {
      if (passo.mediaTipo === "foto") {
        await bot.sendPhoto(msg.chat.id, passo.mediaUrl, { caption: legenda });
      } else if (passo.mediaTipo === "video") {
        await bot.sendVideo(msg.chat.id, passo.mediaUrl, { caption: legenda });
      } else if (passo.mediaTipo === "audio") {
        await bot.sendAudio(msg.chat.id, passo.mediaUrl);
      }
    } catch (err) {
      log(config.nome, `Erro ao enviar mídia no pvt: ${err.message}`);
      if (passo.texto) {
        await bot.sendMessage(msg.chat.id, resolverTexto(passo.texto, config));
      }
    }
  } else if (passo.texto) {
    await bot.sendMessage(msg.chat.id, resolverTexto(passo.texto, config));
  }

  // Avança passo
  const proximoOrdem = conversa.passoAtual + 1;
  const temProximo = funil.passos.some(p => p.ordem === proximoOrdem);

  await prisma.conversa.update({
    where: { id: conversa.id },
    data: {
      passoAtual: temProximo ? proximoOrdem : conversa.passoAtual,
      atualizadoEm: new Date(),
    },
  });

  log(config.nome, `Funil pvt com ${telegramId}: passo ${conversa.passoAtual} -> ${proximoOrdem}`);
}

// ============================================================
// INICIALIZAÇÃO DE CADA BOT
// ============================================================

async function iniciarBot(config) {
  if (botsAtivos.has(config.id)) await pararBot(config.id);

  try {
    const bot = new TelegramBot(config.token, { polling: true });
    log(config.nome, "Iniciado!");

    // Mensagens privadas
    bot.on("message", async (msg) => {
      if (msg.chat.type !== "private") return;
      await processarMensagemPrivada(bot, msg, config);
    });

    bot.on("polling_error", (err) => log(config.nome, `Polling error: ${err.message}`));

    // Agenda cronograma diário
    const timers = agendarCronograma(bot, config);

    botsAtivos.set(config.id, { bot, timers, nome: config.nome });
    return true;
  } catch (err) {
    log(config.nome, `Falha: ${err.message}`);
    return false;
  }
}

function agendarCronograma(bot, config) {
  const slots = gerarSlotsHoje();
  const timers = [];

  // Distribui os bots pelos slots — cada bot pega slots específicos
  // Para não sobrecarregar, cada bot ativa em ~1 slot a cada 3
  const slotsDoBot = slots.filter((_, i) => i % Math.max(1, Math.floor(slots.length / 3)) === (config.id % 3));

  for (const slot of slotsDoBot) {
    const ms = msAteSlot(slot);
    if (ms > 0) {
      const t = setTimeout(async () => {
        // Recarrega config do banco antes de postar (pode ter mudado)
        const configAtual = await prisma.bot.findUnique({ where: { id: config.id } });
        if (configAtual && configAtual.ativo) {
          await postarNoGrupo(bot, configAtual);
        }
      }, ms);
      timers.push(t);
    }
  }

  log(config.nome, `Cronograma: ${slotsDoBot.length} posts agendados para hoje`);

  // Reagenda para o próximo dia à meia-noite
  const meianoite = new Date();
  meianoite.setDate(meianoite.getDate() + 1);
  meianoite.setHours(0, 1, 0, 0);
  const msAteMeiaNoite = meianoite.getTime() - Date.now();

  const tReset = setTimeout(() => {
    const inst = botsAtivos.get(config.id);
    if (inst) {
      inst.timers.forEach(t => clearTimeout(t));
      inst.timers = agendarCronograma(bot, config);
    }
  }, msAteMeiaNoite);

  timers.push(tReset);
  return timers;
}

async function pararBot(botId) {
  const inst = botsAtivos.get(botId);
  if (!inst) return;
  inst.timers.forEach(t => clearTimeout(t));
  try { await inst.bot.stopPolling(); } catch (_) {}
  botsAtivos.delete(botId);
  log(inst.nome, "Parado.");
}

async function iniciarTodosBots() {
  const bots = await prisma.bot.findMany({ where: { ativo: true } });
  log("SISTEMA", `Iniciando ${bots.length} bots...`);
  for (const b of bots) await iniciarBot(b);
  log("SISTEMA", `${bots.length} bots prontos!`);
}

function getStatus() {
  const s = {};
  for (const [id, inst] of botsAtivos.entries()) s[id] = { online: true, nome: inst.nome };
  return s;
}

function isBotAtivo(id) { return botsAtivos.has(id); }

module.exports = { iniciarBot, pararBot, iniciarTodosBots, getStatus, isBotAtivo };
