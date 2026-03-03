const TelegramBot = require("node-telegram-bot-api");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const botsAtivos = new Map(); // id -> { bot, timers, nome, sexo }

function log(nome, msg) {
  console.log(`[${new Date().toLocaleTimeString("pt-BR")}] [${nome}] ${msg}`);
}

// ============================================================
// NÍVEIS DE ATIVIDADE — msgs/hora por período
// ============================================================
const NIVEIS = [
  { inicio: "01:10", fim: "07:30", nivel: "baixo",    minMS: 72000,  maxMS: 120000 }, // 30-50/h
  { inicio: "07:30", fim: "10:00", nivel: "alto",     minMS: 14400,  maxMS: 20000  }, // 180-250/h
  { inicio: "10:00", fim: "12:40", nivel: "baixo",    minMS: 72000,  maxMS: 120000 },
  { inicio: "12:40", fim: "14:20", nivel: "medio",    minMS: 30000,  maxMS: 45000  }, // 80-120/h
  { inicio: "14:20", fim: "17:30", nivel: "baixo",    minMS: 72000,  maxMS: 120000 },
  { inicio: "17:30", fim: "19:00", nivel: "alto",     minMS: 14400,  maxMS: 20000  },
  { inicio: "19:00", fim: "23:00", nivel: "frenetico",minMS: 6000,   maxMS: 9000   }, // 400-600/h
  { inicio: "23:00", fim: "00:10", nivel: "alto",     minMS: 14400,  maxMS: 20000  },
  { inicio: "00:10", fim: "01:10", nivel: "medio",    minMS: 30000,  maxMS: 45000  },
];

function getNivelAtual() {
  const agora = new Date();
  const hm = agora.getHours() * 60 + agora.getMinutes();
  function toMin(str) {
    const [h, m] = str.split(":").map(Number);
    return h * 60 + m;
  }
  for (const n of NIVEIS) {
    const ini = toMin(n.inicio);
    const fim = toMin(n.fim);
    if (fim > ini) { if (hm >= ini && hm < fim) return n; }
    else { if (hm >= ini || hm < fim) return n; } // passa meia-noite
  }
  return NIVEIS[0];
}

function intervaloAleatorio() {
  const n = getNivelAtual();
  return Math.floor(Math.random() * (n.maxMS - n.minMS)) + n.minMS;
}

// ============================================================
// UTILS
// ============================================================
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function resolverTexto(texto, bot) {
  if (!texto) return "";
  return texto
    .replace(/{nome}/g, bot.nome)
    .replace(/{idade}/g, bot.idade)
    .replace(/{cidade}/g, bot.cidade);
}

async function getMidiaAleatoria(botId) {
  const cats = ["apresentacao", "rotina", "interacao", "chamada_pvt"];
  const cat = rand(cats);
  const midias = await prisma.midia.findMany({ where: { botId, categoria: cat } });
  return midias.length ? rand(midias) : null;
}

async function enviarMensagem(bot, grupoId, config, texto, mediaUrl, mediaTipo) {
  try {
    if (mediaUrl) {
      const caption = resolverTexto(texto, config);
      if (mediaTipo === "foto")       await bot.sendPhoto(grupoId, mediaUrl, { caption });
      else if (mediaTipo === "video") await bot.sendVideo(grupoId, mediaUrl, { caption });
      else if (mediaTipo === "audio") await bot.sendAudio(grupoId, mediaUrl);
    } else if (texto) {
      await bot.sendMessage(grupoId, resolverTexto(texto, config));
    }
    await prisma.bot.update({ where: { id: config.id }, data: { ultimaMsg: new Date() } }).catch(() => {});
  } catch (err) {
    log(config.nome, `Erro ao enviar: ${err.message}`);
  }
}

// ============================================================
// CAMADA 1 — EVENTOS GLOBAIS DIÁRIOS
// Bom dia, boa tarde, boa noite etc.
// Só bots femininos participam
// ============================================================
function agendarEventosGlobais(instancias) {
  const timers = [];

  async function scheduleHoje() {
    const globais = await prisma.eventoGlobal.findMany({ where: { ativo: true } });
    const agora = new Date();

    for (const ev of globais) {
      const [h, m] = ev.horario.split(":").map(Number);
      const alvo = new Date();
      alvo.setHours(h, m, 0, 0);
      if (alvo <= agora) alvo.setDate(alvo.getDate() + 1);

      const msAte = alvo.getTime() - Date.now();

      const t = setTimeout(async () => {
        let variacoes = [];
        try { variacoes = JSON.parse(ev.variacoes); } catch (_) {}
        if (!variacoes.length) return;

        // Pega todos os bots femininos ativos com instância rodando
        const botsF = [...instancias.values()].filter(i => i.sexo === "F" && i.bot);
        const shuffled = botsF.sort(() => Math.random() - 0.5);

        let delay = 0;
        for (const inst of shuffled) {
          const texto = rand(variacoes);
          const d = delay;
          setTimeout(async () => {
            const cfg = await prisma.bot.findUnique({ where: { id: inst.botId } });
            if (cfg && cfg.ativo) {
              try { await inst.bot.sendMessage(cfg.grupoId, resolverTexto(texto, cfg)); }
              catch (err) { log(cfg.nome, `Erro global: ${err.message}`); }
            }
          }, d);
          delay += Math.floor(Math.random() * 17000) + 8000; // 8-25s entre cada bot
        }
        log("GLOBAL", `${ev.nome} disparado para ${shuffled.length} bots`);
      }, msAte);

      timers.push(t);
    }

    // Reagenda para o próximo dia
    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    amanha.setHours(0, 0, 30, 0);
    const tReset = setTimeout(() => scheduleHoje(), amanha.getTime() - Date.now());
    timers.push(tReset);
  }

  scheduleHoje();
  return timers;
}

// ============================================================
// CAMADA 2 — ROTEIRO DO DIA (ciclo)
// ============================================================
async function getDiaAtualCiclo() {
  let cfg = await prisma.config.findUnique({ where: { chave: "ciclo_inicio" } });
  if (!cfg) {
    cfg = await prisma.config.create({ data: { chave: "ciclo_inicio", valor: new Date().toISOString() } });
  }
  const inicio = new Date(cfg.valor);
  const hoje = new Date();
  const diffDias = Math.floor((hoje - inicio) / (1000 * 60 * 60 * 24));
  const totalDias = await prisma.roteiroDia.count({ where: { ativo: true } });
  if (totalDias === 0) return null;
  return (diffDias % totalDias) + 1;
}

async function agendarRoteiroDia(instancias) {
  const timers = [];
  const diaNum = await getDiaAtualCiclo();
  if (!diaNum) return timers;

  const roteiro = await prisma.roteiroDia.findUnique({
    where: { dia: diaNum },
    include: { eventos: { orderBy: { horario: "asc" } } },
  });
  if (!roteiro) return timers;

  log("ROTEIRO", `Dia ${diaNum} — ${roteiro.eventos.length} eventos agendados`);

  const agora = new Date();

  for (const ev of roteiro.eventos) {
    const [h, m, s] = ev.horario.split(":").map(Number);
    const alvo = new Date();
    alvo.setHours(h, m, s || 0, 0);
    if (alvo <= agora) continue; // já passou hoje

    const msAte = alvo.getTime() - Date.now();
    const t = setTimeout(async () => {
      const inst = instancias.get(ev.botId);
      if (!inst) return;
      const cfg = await prisma.bot.findUnique({ where: { id: ev.botId } });
      if (!cfg || !cfg.ativo) return;
      await enviarMensagem(inst.bot, cfg.grupoId, cfg, ev.texto, ev.mediaUrl, ev.mediaTipo);
      log(cfg.nome, `Roteiro dia ${diaNum}: "${(ev.texto || "midia").substring(0, 40)}"`);
    }, msAte);
    timers.push(t);
  }

  // Reagenda roteiro amanhã
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);
  amanha.setHours(0, 1, 0, 0);
  const tAmanha = setTimeout(() => agendarRoteiroDia(instancias), amanha.getTime() - Date.now());
  timers.push(tAmanha);

  return timers;
}

// ============================================================
// CAMADA 3 — MÍDIAS ALEATÓRIAS (cronograma por nível)
// Janela: 06:00 – 01:00
// ============================================================
function dentroJanela() {
  const h = new Date().getHours();
  const m = new Date().getMinutes();
  const total = h * 60 + m;
  return total >= 360 || total < 60; // 06:00 até 01:00
}

function agendarMidiaAleatoriaBot(bot, config) {
  if (!botsAtivos.has(config.id)) return;

  async function tick() {
    if (!botsAtivos.has(config.id)) return;
    const inst = botsAtivos.get(config.id);

    if (dentroJanela()) {
      const cfgAtual = await prisma.bot.findUnique({ where: { id: config.id } });
      if (cfgAtual && cfgAtual.ativo) {
        const midia = await getMidiaAleatoria(config.id);
        if (midia) {
          await enviarMensagem(inst.bot, cfgAtual.grupoId, cfgAtual, midia.legenda, midia.url, midia.url ? midia.tipo : null);
          log(config.nome, `Midia [${midia.categoria}/${midia.tipo}]`);
        }
      }
    }

    const intervalo = intervaloAleatorio();
    const t = setTimeout(tick, intervalo);
    if (botsAtivos.has(config.id)) {
      const i = botsAtivos.get(config.id);
      i.timerMidia = t;
    }
  }

  // Inicia com um delay inicial aleatório para não todos ao mesmo tempo
  const inicioAleatorio = Math.floor(Math.random() * 60000);
  const t = setTimeout(tick, inicioAleatorio);
  return t;
}

// ============================================================
// FUNIL DO PRIVADO
// ============================================================
async function processarPrivado(bot, msg, config) {
  const telegramId = String(msg.chat.id);
  if (!config.funilId) {
    bot.sendMessage(msg.chat.id, resolverTexto("Oi! Sou a {nome}, de {cidade}. Me chama!", config));
    return;
  }
  const funil = await prisma.funil.findUnique({
    where: { id: config.funilId },
    include: { passos: { orderBy: { ordem: "asc" } } },
  });
  if (!funil || !funil.passos.length) return;

  let conversa = await prisma.conversa.findUnique({
    where: { botId_telegramId: { botId: config.id, telegramId } },
  });
  if (!conversa) {
    conversa = await prisma.conversa.create({ data: { botId: config.id, telegramId, passoAtual: 0 } });
  }

  const passo = funil.passos.find(p => p.ordem === conversa.passoAtual);
  if (!passo) {
    await prisma.conversa.update({ where: { id: conversa.id }, data: { passoAtual: 0, atualizadoEm: new Date() } });
    return;
  }

  if (passo.delay > 0) {
    await bot.sendChatAction(msg.chat.id, "typing");
    await new Promise(r => setTimeout(r, passo.delay * 1000));
  }

  if (passo.mediaUrl) {
    try {
      const cap = resolverTexto(passo.texto, config);
      if (passo.mediaTipo === "foto")       await bot.sendPhoto(msg.chat.id, passo.mediaUrl, { caption: cap });
      else if (passo.mediaTipo === "video") await bot.sendVideo(msg.chat.id, passo.mediaUrl, { caption: cap });
      else if (passo.mediaTipo === "audio") await bot.sendAudio(msg.chat.id, passo.mediaUrl);
    } catch (_) {
      if (passo.texto) await bot.sendMessage(msg.chat.id, resolverTexto(passo.texto, config));
    }
  } else if (passo.texto) {
    await bot.sendMessage(msg.chat.id, resolverTexto(passo.texto, config));
  }

  const prox = conversa.passoAtual + 1;
  const temProx = funil.passos.some(p => p.ordem === prox);
  await prisma.conversa.update({
    where: { id: conversa.id },
    data: { passoAtual: temProx ? prox : conversa.passoAtual, atualizadoEm: new Date() },
  });
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================
let timersGlobais = [];
let timersRoteiro = [];

async function iniciarBot(config) {
  if (botsAtivos.has(config.id)) await pararBot(config.id);
  try {
    const bot = new TelegramBot(config.token, { polling: true });
    log(config.nome, "Iniciado!");

    bot.on("message", async (msg) => {
      if (msg.chat.type !== "private") return;
      await processarPrivado(bot, msg, config);
    });
    bot.on("polling_error", err => log(config.nome, `Polling: ${err.message}`));

    const timerMidia = agendarMidiaAleatoriaBot(bot, config);

    botsAtivos.set(config.id, {
      bot,
      botId: config.id,
      nome: config.nome,
      sexo: config.sexo || "F",
      timerMidia,
    });
    return true;
  } catch (err) {
    log(config.nome, `Falha: ${err.message}`);
    return false;
  }
}

async function pararBot(botId) {
  const inst = botsAtivos.get(botId);
  if (!inst) return;
  if (inst.timerMidia) clearTimeout(inst.timerMidia);
  try { await inst.bot.stopPolling(); } catch (_) {}
  botsAtivos.delete(botId);
  log(inst.nome, "Parado.");
}

async function iniciarTodosBots() {
  const bots = await prisma.bot.findMany({ where: { ativo: true } });
  log("SISTEMA", `Iniciando ${bots.length} bots...`);
  for (const b of bots) await iniciarBot(b);
  log("SISTEMA", "Todos os bots iniciados!");

  // Inicia camadas globais
  timersGlobais = agendarEventosGlobais(botsAtivos);
  timersRoteiro = await agendarRoteiroDia(botsAtivos);
  log("SISTEMA", "Camadas global e roteiro ativas!");
}

function getStatus() {
  const s = {};
  for (const [id, inst] of botsAtivos.entries()) s[id] = { online: true, nome: inst.nome };
  return s;
}
function isBotAtivo(id) { return botsAtivos.has(id); }
function getBotsAtivos() { return botsAtivos; }

module.exports = { iniciarBot, pararBot, iniciarTodosBots, getStatus, isBotAtivo, getBotsAtivos };
