require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { iniciarTodosBots, iniciarBot, pararBot, getStatus, getBotsAtivos } = require("./botManager");

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));
app.use(session({
  secret: process.env.SESSION_SECRET || "segredo",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
}));

async function seedAdmin() {
  const existe = await prisma.admin.count();
  if (existe === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_SENHA || "admin123", 10);
    await prisma.admin.create({ data: { user: process.env.ADMIN_USER || "admin", senha: hash } });
    console.log("[SETUP] Admin criado:", process.env.ADMIN_USER || "admin");
  }

  // Seeds de eventos globais padrão
  const evGlobal = await prisma.eventoGlobal.count();
  if (evGlobal === 0) {
    await prisma.eventoGlobal.createMany({ data: [
      { nome: "bom_dia",   horario: "07:35", variacoes: JSON.stringify(["bom dia galera","boaaaa","bom diaaaa gente","dia!","acordei kkk","boa madrugada ainda aqui kkk","gente bom dia","oi sumidas, bom dia!"]) },
      { nome: "boa_tarde", horario: "13:15", variacoes: JSON.stringify(["boa tarde pessoal","tardinha","oi gente","passou rapido esse dia","tarde boa pra todas","e ai gente, boa tarde"]) },
      { nome: "boa_noite", horario: "22:10", variacoes: JSON.stringify(["boa noite gente","ate amanha","vou dormir logo","noite!","noitinha boa pra todas","tô indo dormir, boa noite"]) },
      { nome: "almoco",    horario: "12:05", variacoes: JSON.stringify(["almoço feito","hora do almoço","comendo agora","meu almoço hoje ficou uma delicia","partiu almoço"]) },
    ]});
    console.log("[SETUP] Eventos globais padrão criados");
  }
}

function auth(req, res, next) {
  if (req.session.logado) return next();
  res.status(401).json({ erro: "Nao autenticado" });
}

// ---- AUTH ----
app.post("/api/login", async (req, res) => {
  const { user, senha } = req.body;
  const admin = await prisma.admin.findUnique({ where: { user } });
  if (!admin) return res.status(401).json({ erro: "Usuario nao encontrado" });
  const ok = await bcrypt.compare(senha, admin.senha);
  if (!ok) return res.status(401).json({ erro: "Senha incorreta" });
  req.session.logado = true;
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get("/api/me", (req, res) => res.json({ logado: !!req.session.logado }));

// ---- BOTS ----
app.get("/api/bots", auth, async (req, res) => {
  const bots = await prisma.bot.findMany({
    include: {
      funil: { select: { id: true, nome: true } },
      _count: { select: { midias: true, conversas: true } },
    },
    orderBy: { criadoEm: "desc" },
  });
  const status = getStatus();
  res.json(bots.map(b => ({ ...b, online: !!status[b.id] })));
});

app.post("/api/bots", auth, async (req, res) => {
  try {
    const { nome, idade, cidade, sexo, token, grupoId, funilId } = req.body;
    const bot = await prisma.bot.create({
      data: { nome, idade: parseInt(idade)||24, cidade: cidade||"Sao Paulo", sexo: sexo||"F", token, grupoId, funilId: funilId ? parseInt(funilId) : null },
    });
    await iniciarBot(bot);
    res.json(bot);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.put("/api/bots/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { nome, idade, cidade, sexo, token, grupoId, funilId, ativo } = req.body;
    const bot = await prisma.bot.update({
      where: { id },
      data: { nome, idade: parseInt(idade)||24, cidade, sexo: sexo||"F", token, grupoId, funilId: funilId ? parseInt(funilId) : null, ativo: ativo === "true" || ativo === true },
    });
    if (bot.ativo) await iniciarBot(bot); else await pararBot(id);
    res.json(bot);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete("/api/bots/:id", auth, async (req, res) => {
  const id = parseInt(req.params.id);
  await pararBot(id);
  await prisma.bot.delete({ where: { id } });
  res.json({ ok: true });
});

app.post("/api/bots/:id/toggle", auth, async (req, res) => {
  const id = parseInt(req.params.id);
  const bot = await prisma.bot.findUnique({ where: { id } });
  const novoAtivo = !bot.ativo;
  await prisma.bot.update({ where: { id }, data: { ativo: novoAtivo } });
  if (novoAtivo) await iniciarBot({ ...bot, ativo: true }); else await pararBot(id);
  res.json({ ativo: novoAtivo });
});

app.get("/api/status", auth, (req, res) => res.json(getStatus()));

// ---- MÍDIAS ----
app.get("/api/bots/:id/midias", auth, async (req, res) => {
  res.json(await prisma.midia.findMany({ where: { botId: parseInt(req.params.id) }, orderBy: { criadoEm: "desc" } }));
});
app.post("/api/bots/:id/midias", auth, async (req, res) => {
  try {
    const { categoria, tipo, url, legenda } = req.body;
    res.json(await prisma.midia.create({ data: { botId: parseInt(req.params.id), categoria, tipo, url, legenda } }));
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put("/api/midias/:id", auth, async (req, res) => {
  try {
    const { categoria, tipo, url, legenda } = req.body;
    res.json(await prisma.midia.update({ where: { id: parseInt(req.params.id) }, data: { categoria, tipo, url, legenda } }));
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete("/api/midias/:id", auth, async (req, res) => {
  await prisma.midia.delete({ where: { id: parseInt(req.params.id) } });
  res.json({ ok: true });
});

// ---- FUNIS ----
app.get("/api/funis", auth, async (req, res) => {
  res.json(await prisma.funil.findMany({ include: { passos: { orderBy: { ordem: "asc" } } }, orderBy: { criadoEm: "desc" } }));
});
app.post("/api/funis", auth, async (req, res) => {
  try {
    const { nome, descricao, passos } = req.body;
    const funil = await prisma.funil.create({
      data: { nome, descricao, passos: { create: (passos||[]).map((p,i) => ({ ordem: i, texto: p.texto, mediaUrl: p.mediaUrl||null, mediaTipo: p.mediaTipo||null, delay: parseInt(p.delay)||2 })) } },
      include: { passos: { orderBy: { ordem: "asc" } } },
    });
    res.json(funil);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put("/api/funis/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { nome, descricao, passos } = req.body;
    await prisma.passo.deleteMany({ where: { funilId: id } });
    const funil = await prisma.funil.update({
      where: { id },
      data: { nome, descricao, passos: { create: (passos||[]).map((p,i) => ({ ordem: i, texto: p.texto, mediaUrl: p.mediaUrl||null, mediaTipo: p.mediaTipo||null, delay: parseInt(p.delay)||2 })) } },
      include: { passos: { orderBy: { ordem: "asc" } } },
    });
    res.json(funil);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete("/api/funis/:id", auth, async (req, res) => {
  await prisma.funil.delete({ where: { id: parseInt(req.params.id) } });
  res.json({ ok: true });
});

// ---- EVENTOS GLOBAIS ----
app.get("/api/globais", auth, async (req, res) => {
  res.json(await prisma.eventoGlobal.findMany({ orderBy: { horario: "asc" } }));
});
app.post("/api/globais", auth, async (req, res) => {
  try {
    const { nome, horario, variacoes } = req.body;
    const ev = await prisma.eventoGlobal.create({ data: { nome, horario, variacoes: JSON.stringify(variacoes) } });
    res.json(ev);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put("/api/globais/:id", auth, async (req, res) => {
  try {
    const { nome, horario, variacoes, ativo } = req.body;
    const ev = await prisma.eventoGlobal.update({
      where: { id: parseInt(req.params.id) },
      data: { nome, horario, variacoes: JSON.stringify(variacoes), ativo: ativo !== false },
    });
    res.json(ev);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete("/api/globais/:id", auth, async (req, res) => {
  await prisma.eventoGlobal.delete({ where: { id: parseInt(req.params.id) } });
  res.json({ ok: true });
});

// ---- ROTEIROS ----
app.get("/api/roteiros", auth, async (req, res) => {
  const roteiros = await prisma.roteiroDia.findMany({
    include: { _count: { select: { eventos: true } } },
    orderBy: { dia: "asc" },
  });
  res.json(roteiros);
});

app.get("/api/roteiros/:dia", auth, async (req, res) => {
  const roteiro = await prisma.roteiroDia.findUnique({
    where: { dia: parseInt(req.params.dia) },
    include: { eventos: { include: { bot: { select: { id: true, nome: true, sexo: true } } }, orderBy: { horario: "asc" } } },
  });
  res.json(roteiro);
});

app.post("/api/roteiros", auth, async (req, res) => {
  try {
    const { dia, eventos } = req.body;
    const existe = await prisma.roteiroDia.findUnique({ where: { dia: parseInt(dia) } });
    if (existe) return res.status(400).json({ erro: "Dia " + dia + " ja existe" });
    const roteiro = await prisma.roteiroDia.create({
      data: {
        dia: parseInt(dia),
        eventos: { create: (eventos||[]).map((e,i) => ({ botId: parseInt(e.botId), horario: e.horario, texto: e.texto||null, mediaUrl: e.mediaUrl||null, mediaTipo: e.mediaTipo||null, ordem: i })) },
      },
      include: { _count: { select: { eventos: true } } },
    });
    res.json(roteiro);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.put("/api/roteiros/:dia", auth, async (req, res) => {
  try {
    const dia = parseInt(req.params.dia);
    const { eventos } = req.body;
    const roteiro = await prisma.roteiroDia.findUnique({ where: { dia } });
    if (!roteiro) return res.status(404).json({ erro: "Nao encontrado" });
    await prisma.eventoRoteiro.deleteMany({ where: { roteiroDiaId: roteiro.id } });
    await prisma.eventoRoteiro.createMany({
      data: (eventos||[]).map((e,i) => ({ roteiroDiaId: roteiro.id, botId: parseInt(e.botId), horario: e.horario, texto: e.texto||null, mediaUrl: e.mediaUrl||null, mediaTipo: e.mediaTipo||null, ordem: i })),
    });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete("/api/roteiros/:dia", auth, async (req, res) => {
  const roteiro = await prisma.roteiroDia.findUnique({ where: { dia: parseInt(req.params.dia) } });
  if (roteiro) await prisma.roteiroDia.delete({ where: { id: roteiro.id } });
  res.json({ ok: true });
});

// Importar roteiro via JSON
app.post("/api/roteiros/importar", auth, async (req, res) => {
  try {
    const { dia, eventos } = req.body;
    const existe = await prisma.roteiroDia.findUnique({ where: { dia: parseInt(dia) } });
    if (existe) {
      await prisma.eventoRoteiro.deleteMany({ where: { roteiroDiaId: existe.id } });
      await prisma.eventoRoteiro.createMany({
        data: eventos.map((e,i) => ({ roteiroDiaId: existe.id, botId: parseInt(e.botId), horario: e.horario, texto: e.texto||null, mediaUrl: e.mediaUrl||null, mediaTipo: e.mediaTipo||null, ordem: i })),
      });
      return res.json({ ok: true, dia, eventos: eventos.length, acao: "atualizado" });
    }
    const roteiro = await prisma.roteiroDia.create({
      data: {
        dia: parseInt(dia),
        eventos: { create: eventos.map((e,i) => ({ botId: parseInt(e.botId), horario: e.horario, texto: e.texto||null, mediaUrl: e.mediaUrl||null, mediaTipo: e.mediaTipo||null, ordem: i })) },
      },
    });
    res.json({ ok: true, dia, eventos: eventos.length, acao: "criado" });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// Status do ciclo
app.get("/api/ciclo", auth, async (req, res) => {
  const cfg = await prisma.config.findUnique({ where: { chave: "ciclo_inicio" } });
  const totalDias = await prisma.roteiroDia.count({ where: { ativo: true } });
  if (!cfg || totalDias === 0) return res.json({ diaAtual: null, totalDias, inicio: null });
  const inicio = new Date(cfg.valor);
  const diffDias = Math.floor((new Date() - inicio) / (1000 * 60 * 60 * 24));
  const diaAtual = (diffDias % totalDias) + 1;
  res.json({ diaAtual, totalDias, inicio: cfg.valor });
});

app.post("/api/ciclo/reiniciar", auth, async (req, res) => {
  await prisma.config.upsert({
    where: { chave: "ciclo_inicio" },
    update: { valor: new Date().toISOString() },
    create: { chave: "ciclo_inicio", valor: new Date().toISOString() },
  });
  res.json({ ok: true });
});

// ---- DASHBOARD ----
app.get("/api/dashboard", auth, async (req, res) => {
  const [totalBots, totalMidias, totalFunis, totalConversas, totalRoteiros, totalGlobais] = await Promise.all([
    prisma.bot.count(), prisma.midia.count(), prisma.funil.count(),
    prisma.conversa.count(), prisma.roteiroDia.count(), prisma.eventoGlobal.count(),
  ]);
  const status = getStatus();
  res.json({ totalBots, totalMidias, totalFunis, totalConversas, totalRoteiros, totalGlobais, botsOnline: Object.keys(status).length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[SERVIDOR] Porta ${PORT}`);
  await seedAdmin();
  await iniciarTodosBots();
});
