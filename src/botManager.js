const TelegramBot = require("node-telegram-bot-api");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const botsAtivos = new Map();

function log(nome, msg) {
  console.log(`[${new Date().toLocaleTimeString("pt-BR")}] [${nome}] ${msg}`);
}

// ============================================================
// NÍVEIS DE ATIVIDADE
// ============================================================
const NIVEIS = [
  { inicio: "01:10", fim: "07:30", minMS: 72000,  maxMS: 120000 },
  { inicio: "07:30", fim: "10:00", minMS: 14400,  maxMS: 20000  },
  { inicio: "10:00", fim: "12:40", minMS: 72000,  maxMS: 120000 },
  { inicio: "12:40", fim: "14:20", minMS: 30000,  maxMS: 45000  },
  { inicio: "14:20", fim: "17:30", minMS: 72000,  maxMS: 120000 },
  { inicio: "17:30", fim: "19:00", minMS: 14400,  maxMS: 20000  },
  { inicio: "19:00", fim: "23:00", minMS: 6000,   maxMS: 9000   },
  { inicio: "23:00", fim: "00:10", minMS: 14400,  maxMS: 20000  },
  { inicio: "00:10", fim: "01:10", minMS: 30000,  maxMS: 45000  },
];

function toMin(str) {
  const [h, m] = str.split(":").map(Number);
  return h * 60 + m;
}

function getNivelAtual() {
  const agora = new Date();
  const hm = agora.getHours() * 60 + agora.getMinutes();
  for (const n of NIVEIS) {
    const ini = toMin(n.inicio), fim = toMin(n.fim);
    if (fim > ini) { if (hm >= ini && hm < fim) return n; }
    else { if (hm >= ini || hm < fim) return n; }
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
function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

function resolverTexto(texto, bot) {
  if (!texto) return "";
  return texto
    .replace(/{nome}/g, bot.nome)
    .replace(/{idade}/g, bot.idade)
    .replace(/{cidade}/g, bot.cidade);
}

// Converte "HH:MM" ou "HH:MM:SS" para ms desde meia-noite
function horarioParaMs(str) {
  const parts = str.split(":").map(Number);
  return ((parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0)) * 1000;
}

// ms até um determinado horário hoje (ou amanhã se já passou)
function msAteHorario(horarioMs) {
  const agora = new Date();
  const inicioHoje = new Date(agora);
  inicioHoje.setHours(0, 0, 0, 0);
  let alvo = inicioHoje.getTime() + horarioMs;
  if (alvo <= agora.getTime()) alvo += 24 * 3600 * 1000;
  return alvo - agora.getTime();
}

// Retorna ms aleatório dentro de uma janela [inicioMs, fimMs]
function msAleatorioNaJanela(inicioMs, fimMs) {
  if (fimMs < inicioMs) fimMs += 24 * 3600 * 1000; // passa meia-noite
  return inicioMs + Math.floor(Math.random() * (fimMs - inicioMs));
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
// Suporta dois modos:
//   - horário fixo: campo "horario" = "HH:MM", janela* ausentes
//   - janela com pico: campos "janelaInicio", "janelaFim", "pico" no JSON de variacoes
//     Ex: variacoes = { "pico": "08:30", "janelaInicio": "06:00", "janelaFim": "10:30", "textos": [...] }
// ============================================================

// Detecta se o evento usa janela ou horário fixo
function parseEventoGlobal(ev) {
  let variacoes = [];
  let config = null;
  try {
    const parsed = JSON.parse(ev.variacoes);
    if (Array.isArray(parsed)) {
      variacoes = parsed;
    } else if (parsed.textos) {
      variacoes = parsed.textos;
      config = parsed; // tem janelaInicio, janelaFim, pico
    }
  } catch (_) {}
  return { variacoes, config };
}

// Distribui bots na janela com pico
// Grupos: 30% antes do pico (inicio→pico), 50% no pico (±30min), 20% depois (pico→fim)
function distribuirBotsNaJanela(botsF, janelaInicio, janelaFim, pico) {
  const iniMs  = horarioParaMs(janelaInicio);
  const fimMs  = horarioParaMs(janelaFim);
  const picoMs = horarioParaMs(pico);
  const picoIniMs = Math.max(iniMs, picoMs - 30 * 60 * 1000);
  const picoFimMs = Math.min(fimMs, picoMs + 30 * 60 * 1000);

  const shuffled = shuffle(botsF);
  const total = shuffled.length;
  const nAntes  = Math.floor(total * 0.30);
  const nPico   = Math.floor(total * 0.50);
  // o resto vai depois do pico

  const resultado = [];

  shuffled.slice(0, nAntes).forEach(inst => {
    resultado.push({ inst, targetMs: msAleatorioNaJanela(iniMs, picoIniMs) });
  });
  shuffled.slice(nAntes, nAntes + nPico).forEach(inst => {
    resultado.push({ inst, targetMs: msAleatorioNaJanela(picoIniMs, picoFimMs) });
  });
  shuffled.slice(nAntes + nPico).forEach(inst => {
    resultado.push({ inst, targetMs: msAleatorioNaJanela(picoFimMs, fimMs) });
  });

  return resultado;
}

// Distribui bots em janela simples (sem pico)
function distribuirBotsJanelaSimples(botsF, janelaInicio, janelaFim) {
  const iniMs = horarioParaMs(janelaInicio);
  const fimMs = horarioParaMs(janelaFim);
  return shuffle(botsF).map(inst => ({
    inst,
    targetMs: msAleatorioNaJanela(iniMs, fimMs),
  }));
}

function agendarEventosGlobais(instancias) {
  const timers = [];

  async function scheduleHoje() {
    const globais = await prisma.eventoGlobal.findMany({ where: { ativo: true } });
    const agora = new Date();
    const agoraMs = agora.getHours() * 3600000 + agora.getMinutes() * 60000 + agora.getSeconds() * 1000;

    const botsF = [...instancias.values()].filter(i => i.sexo === "F" && i.bot);

    for (const ev of globais) {
      const { variacoes, config: cfg } = parseEventoGlobal(ev);
      if (!variacoes.length) continue;

      if (cfg && cfg.janelaInicio && cfg.janelaFim) {
        // MODO JANELA
        const iniMs = horarioParaMs(cfg.janelaInicio);
        const fimMs = horarioParaMs(cfg.janelaFim);

        // Só agenda se a janela ainda não terminou hoje
        if (fimMs <= agoraMs) continue;

        const distribuicao = cfg.pico
          ? distribuirBotsNaJanela(botsF, cfg.janelaInicio, cfg.janelaFim, cfg.pico)
          : distribuirBotsJanelaSimples(botsF, cfg.janelaInicio, cfg.janelaFim);

        let agendados = 0;
        for (const { inst, targetMs } of distribuicao) {
          if (targetMs <= agoraMs) continue; // já passou
          const msAte = targetMs - agoraMs;
          const texto = rand(variacoes);
          const t = setTimeout(async () => {
            const cfg2 = await prisma.bot.findUnique({ where: { id: inst.botId } });
            if (!cfg2 || !cfg2.ativo) return;
            try { await inst.bot.sendMessage(cfg2.grupoId, resolverTexto(texto, cfg2)); }
            catch (err) { log(cfg2.nome, `Erro global janela: ${err.message}`); }
          }, msAte);
          timers.push(t);
          agendados++;
        }
        log("GLOBAL", `${ev.nome} (janela ${cfg.janelaInicio}-${cfg.janelaFim}): ${agendados} bots agendados`);

      } else {
        // MODO HORÁRIO FIXO com delay sequencial entre bots
        const [h, m] = ev.horario.split(":").map(Number);
        const alvoMs = h * 3600000 + m * 60000;
        if (alvoMs <= agoraMs && (agoraMs - alvoMs) > 60000) continue; // já passou há mais de 1 min

        const msBase = alvoMs > agoraMs ? alvoMs - agoraMs : 0;
        const shuffled = shuffle(botsF);
        let delay = msBase;

        for (const inst of shuffled) {
          const texto = rand(variacoes);
          const d = delay;
          const t = setTimeout(async () => {
            const cfg2 = await prisma.bot.findUnique({ where: { id: inst.botId } });
            if (!cfg2 || !cfg2.ativo) return;
            try { await inst.bot.sendMessage(cfg2.grupoId, resolverTexto(texto, cfg2)); }
            catch (err) { log(cfg2.nome, `Erro global fixo: ${err.message}`); }
          }, d);
          timers.push(t);
          delay += Math.floor(Math.random() * 17000) + 8000; // 8-25s entre cada bot
        }
        log("GLOBAL", `${ev.nome} (fixo ${ev.horario}): ${shuffled.length} bots agendados`);
      }
    }

    // Reagenda para amanhã à meia-noite
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
  const diffDias = Math.floor((Date.now() - new Date(cfg.valor).getTime()) / (1000 * 60 * 60 * 24));
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

  log("ROTEIRO", `Dia ${diaNum} — ${roteiro.eventos.length} eventos`);

  const agora = new Date();
  const agoraMs = agora.getHours() * 3600000 + agora.getMinutes() * 60000 + agora.getSeconds() * 1000;

  for (const ev of roteiro.eventos) {
    const evMs = horarioParaMs(ev.horario);
    if (evMs <= agoraMs) continue;

    const msAte = evMs - agoraMs;
    const t = setTimeout(async () => {
      const inst = instancias.get(ev.botId);
      if (!inst) return;
      const cfg = await prisma.bot.findUnique({ where: { id: ev.botId } });
      if (!cfg || !cfg.ativo) return;
      await enviarMensagem(inst.bot, cfg.grupoId, cfg, ev.texto, ev.mediaUrl, ev.mediaTipo);
      log(cfg.nome, `Roteiro D${diaNum}: "${(ev.texto || "midia").substring(0, 40)}"`);
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
// CAMADA 3 — MÍDIAS ALEATÓRIAS
// ============================================================
function dentroJanela() {
  const h = new Date().getHours(), m = new Date().getMinutes();
  const total = h * 60 + m;
  return total >= 360 || total < 60;
}

async function getMidiaAleatoria(botId) {
  const cats = ["apresentacao", "rotina", "interacao", "chamada_pvt"];
  const cat = rand(cats);
  const midias = await prisma.midia.findMany({ where: { botId, categoria: cat } });
  return midias.length ? rand(midias) : null;
}

function agendarMidiaAleatoriaBot(bot, config) {
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
    if (botsAtivos.has(config.id)) botsAtivos.get(config.id).timerMidia = t;
  }

  const inicioAleatorio = Math.floor(Math.random() * 60000);
  return setTimeout(tick, inicioAleatorio);
}

// ============================================================
// FUNIL DO PRIVADO
// ============================================================
async function processarPrivado(bot, msg, config) {
  const telegramId = String(msg.chat.id);
  if (!config.funilId) {
    bot.sendMessage(msg.chat.id, resolverTexto("Oi! Sou {nome}, de {cidade}. Me chama!", config));
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
    botsAtivos.set(config.id, { bot, botId: config.id, nome: config.nome, sexo: config.sexo || "F", timerMidia });
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
  log("SISTEMA", "Todos iniciados!");

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

// Reagenda camadas globais e roteiro com os bots ativos atuais
// Chamado sempre que um bot e ligado/desligado apos a inicializacao
async function reagendarCamadas() {
  // Limpa timers anteriores
  timersGlobais.forEach(t => clearTimeout(t));
  timersRoteiro.forEach(t => clearTimeout(t));
  timersGlobais = agendarEventosGlobais(botsAtivos);
  timersRoteiro = await agendarRoteiroDia(botsAtivos);
  log("SISTEMA", `Camadas reagendadas — ${botsAtivos.size} bots ativos`);
}

module.exports = { iniciarBot, pararBot, iniciarTodosBots, getStatus, isBotAtivo, getBotsAtivos, reagendarCamadas };
