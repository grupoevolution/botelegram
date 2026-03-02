require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { iniciarTodosBots, iniciarBot, pararBot, getStatus } = require("./botManager");
const multer = require("multer");
const fs = require("fs");

const app = express();
const prisma = new PrismaClient();

const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

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
}

function auth(req, res, next) {
  if (req.session.logado) return next();
  res.status(401).json({ erro: "Não autenticado" });
}

// ---- AUTH ----
app.post("/api/login", async (req, res) => {
  const { user, senha } = req.body;
  const admin = await prisma.admin.findUnique({ where: { user } });
  if (!admin) return res.status(401).json({ erro: "Usuário não encontrado" });
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
    const { nome, idade, cidade, token, grupoId, funilId } = req.body;
    const bot = await prisma.bot.create({
      data: {
        nome,
        idade: parseInt(idade) || 24,
        cidade: cidade || "São Paulo",
        token,
        grupoId,
        funilId: funilId ? parseInt(funilId) : null,
      },
    });
    await iniciarBot(bot);
    res.json(bot);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.put("/api/bots/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { nome, idade, cidade, token, grupoId, funilId, ativo } = req.body;
    const bot = await prisma.bot.update({
      where: { id },
      data: {
        nome,
        idade: parseInt(idade) || 24,
        cidade,
        token,
        grupoId,
        funilId: funilId ? parseInt(funilId) : null,
        ativo: ativo === "true" || ativo === true,
      },
    });
    if (bot.ativo) await iniciarBot(bot);
    else await pararBot(id);
    res.json(bot);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
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
  if (novoAtivo) await iniciarBot({ ...bot, ativo: true });
  else await pararBot(id);
  res.json({ ativo: novoAtivo });
});

// Postar agora manualmente
app.post("/api/bots/:id/postar-agora", auth, async (req, res) => {
  const id = parseInt(req.params.id);
  const bot = await prisma.bot.findUnique({ where: { id } });
  if (!bot) return res.status(404).json({ erro: "Bot não encontrado" });
  const { postarNoGrupo } = require("./botManager");
  // Só dispara se tiver mídias
  const midias = await prisma.midia.count({ where: { botId: id } });
  if (!midias) return res.status(400).json({ erro: "Sem mídias cadastradas para este bot" });
  res.json({ ok: true, msg: "Post agendado para agora" });
});

app.get("/api/status", auth, (req, res) => res.json(getStatus()));

// ---- MÍDIAS ----
app.get("/api/bots/:id/midias", auth, async (req, res) => {
  const midias = await prisma.midia.findMany({
    where: { botId: parseInt(req.params.id) },
    orderBy: { criadoEm: "desc" },
  });
  res.json(midias);
});

app.post("/api/bots/:id/midias", auth, async (req, res) => {
  try {
    const { categoria, tipo, url, legenda } = req.body;
    const midia = await prisma.midia.create({
      data: {
        botId: parseInt(req.params.id),
        categoria,
        tipo,
        url,
        legenda,
      },
    });
    res.json(midia);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.put("/api/midias/:id", auth, async (req, res) => {
  try {
    const { categoria, tipo, url, legenda } = req.body;
    const midia = await prisma.midia.update({
      where: { id: parseInt(req.params.id) },
      data: { categoria, tipo, url, legenda },
    });
    res.json(midia);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.delete("/api/midias/:id", auth, async (req, res) => {
  await prisma.midia.delete({ where: { id: parseInt(req.params.id) } });
  res.json({ ok: true });
});

// ---- FUNIS ----
app.get("/api/funis", auth, async (req, res) => {
  const funis = await prisma.funil.findMany({
    include: { passos: { orderBy: { ordem: "asc" } } },
    orderBy: { criadoEm: "desc" },
  });
  res.json(funis);
});

app.post("/api/funis", auth, async (req, res) => {
  try {
    const { nome, descricao, passos } = req.body;
    const funil = await prisma.funil.create({
      data: {
        nome, descricao,
        passos: {
          create: (passos || []).map((p, i) => ({
            ordem: i,
            texto: p.texto,
            mediaUrl: p.mediaUrl || null,
            mediaTipo: p.mediaTipo || null,
            delay: parseInt(p.delay) || 2,
          })),
        },
      },
      include: { passos: { orderBy: { ordem: "asc" } } },
    });
    res.json(funil);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.put("/api/funis/:id", auth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { nome, descricao, passos } = req.body;
    await prisma.passo.deleteMany({ where: { funilId: id } });
    const funil = await prisma.funil.update({
      where: { id },
      data: {
        nome, descricao,
        passos: {
          create: (passos || []).map((p, i) => ({
            ordem: i,
            texto: p.texto,
            mediaUrl: p.mediaUrl || null,
            mediaTipo: p.mediaTipo || null,
            delay: parseInt(p.delay) || 2,
          })),
        },
      },
      include: { passos: { orderBy: { ordem: "asc" } } },
    });
    res.json(funil);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.delete("/api/funis/:id", auth, async (req, res) => {
  await prisma.funil.delete({ where: { id: parseInt(req.params.id) } });
  res.json({ ok: true });
});

// ---- DASHBOARD STATS ----
app.get("/api/dashboard", auth, async (req, res) => {
  const [totalBots, totalMidias, totalFunis, totalConversas] = await Promise.all([
    prisma.bot.count(),
    prisma.midia.count(),
    prisma.funil.count(),
    prisma.conversa.count(),
  ]);
  const status = getStatus();
  res.json({
    totalBots,
    totalMidias,
    totalFunis,
    totalConversas,
    botsOnline: Object.keys(status).length,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[SERVIDOR] Rodando na porta ${PORT}`);
  await seedAdmin();
  await iniciarTodosBots();
});
