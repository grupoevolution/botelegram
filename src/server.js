require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { iniciarTodosBots, iniciarBot, pararBot, getStatus, isBotAtivo } = require("./botManager");
const multer = require("multer");
const fs = require("fs");

const app = express();
const prisma = new PrismaClient();

// Upload de fotos
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "../public/uploads");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));
app.use(session({
  secret: process.env.SESSION_SECRET || "segredo",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
}));

// Cria admin padrão se não existir
async function seedAdmin() {
  const existe = await prisma.admin.count();
  if (existe === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_SENHA || "admin123", 10);
    await prisma.admin.create({ data: { user: process.env.ADMIN_USER || "admin", senha: hash } });
    console.log("[SETUP] Admin criado:", process.env.ADMIN_USER || "admin");
  }
}

// Middleware de autenticação
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

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  res.json({ logado: !!req.session.logado });
});

// ---- BOTS ----
app.get("/api/bots", auth, async (req, res) => {
  const bots = await prisma.bot.findMany({ include: { funil: { select: { id: true, nome: true } } }, orderBy: { criadoEm: "desc" } });
  const status = getStatus();
  res.json(bots.map((b) => ({ ...b, online: !!status[b.id] })));
});

app.post("/api/bots", auth, upload.single("foto"), async (req, res) => {
  try {
    const { nome, token, grupoId, apresentacao, intervalMin, intervalMax, funilId } = req.body;
    const bot = await prisma.bot.create({
      data: {
        nome, token, grupoId, apresentacao,
        intervalMin: parseInt(intervalMin) || 30,
        intervalMax: parseInt(intervalMax) || 90,
        funilId: funilId ? parseInt(funilId) : null,
        fotoPerfil: req.file ? req.file.filename : null,
      },
    });
    await iniciarBot(bot);
    res.json(bot);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.put("/api/bots/:id", auth, upload.single("foto"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { nome, token, grupoId, apresentacao, intervalMin, intervalMax, funilId, ativo } = req.body;
    const data = {
      nome, token, grupoId, apresentacao,
      intervalMin: parseInt(intervalMin) || 30,
      intervalMax: parseInt(intervalMax) || 90,
      funilId: funilId ? parseInt(funilId) : null,
      ativo: ativo === "true" || ativo === true,
    };
    if (req.file) data.fotoPerfil = req.file.filename;
    const bot = await prisma.bot.update({ where: { id }, data });
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

app.get("/api/status", auth, (req, res) => {
  res.json(getStatus());
});

// ---- FUNIS ----
app.get("/api/funis", auth, async (req, res) => {
  const funis = await prisma.funil.findMany({ include: { passos: { orderBy: { ordem: "asc" } } }, orderBy: { criadoEm: "desc" } });
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
            mensagem: p.mensagem,
            tipo: p.tipo || "texto",
            botoes: p.botoes || null,
          })),
        },
      },
      include: { passos: true },
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
    // Remove passos antigos e recria
    await prisma.passo.deleteMany({ where: { funilId: id } });
    const funil = await prisma.funil.update({
      where: { id },
      data: {
        nome, descricao,
        passos: {
          create: (passos || []).map((p, i) => ({
            ordem: i,
            mensagem: p.mensagem,
            tipo: p.tipo || "texto",
            botoes: p.botoes || null,
          })),
        },
      },
      include: { passos: true },
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

// Importar funil via JSON
app.post("/api/funis/importar", auth, async (req, res) => {
  try {
    const { nome, descricao, passos } = req.body;
    const funil = await prisma.funil.create({
      data: {
        nome, descricao,
        passos: {
          create: passos.map((p, i) => ({
            ordem: i,
            mensagem: p.mensagem,
            tipo: p.tipo || "texto",
            botoes: p.botoes || null,
          })),
        },
      },
      include: { passos: true },
    });
    res.json(funil);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// Inicialização
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[SERVIDOR] Rodando na porta ${PORT}`);
  await seedAdmin();
  await iniciarTodosBots();
});
