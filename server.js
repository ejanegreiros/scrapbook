require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcrypt');
const sharp = require('sharp');
const { MongoClient } = require('mongodb');
const {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const port = process.env.PORT || 3000;



// ─── ✅ ÍCONES APPLE (PWA iOS) ────────────────────────────────────────────────
app.use(
  "/icons",
  express.static(path.join(__dirname, "public/icons"), {
    setHeaders: (res) => {
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=0");
    }
  })
);

// ─── S3 / R2 ────────────────────────────────────────────────────────────────
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

const publicUrl =
  process.env.R2_PUBLIC_URL || 'https://pub-1b9f56270eda4c8cbdb655d80c3c2ab0.r2.dev';

// ─── MongoDB ─────────────────────────────────────────────────────────────────
const mongoClient = new MongoClient(process.env.MONGO_URI || '');
const dbName = process.env.MONGO_DB || 'r2_gallery';
const collectionName = process.env.MONGO_COLLECTION || 'images';
const usersCollectionName = 'users';

let imageCollection;
let usersCollection;

async function initMongo() {
  if (!process.env.MONGO_URI) {
    console.warn('MONGO_URI não definido. MongoDB não será utilizado.');
    return;
  }

  await mongoClient.connect();
  const db = mongoClient.db(dbName);

  imageCollection = db.collection(collectionName);
  await imageCollection.createIndex({ key: 1 }, { unique: true });

  usersCollection = db.collection(usersCollectionName);
  await usersCollection.createIndex({ username: 1 }, { unique: true });

  // Cria o admin padrão apenas se não existir nenhum usuário ainda
  const count = await usersCollection.countDocuments();
  if (count === 0) {
    const hashedPassword = await bcrypt.hash(
      process.env.ADMIN_PASS || 'admin123',
      12
    );
    await usersCollection.insertOne({
      username: process.env.ADMIN_USER || 'admin',
      password: hashedPassword,
      role: 'admin',
      createdAt: new Date(),
    });
    console.log('Usuário admin padrão criado.');
  }

  console.log('MongoDB conectado em', dbName);
}

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use('/vendor/bootstrap', express.static(path.join(__dirname, 'node_modules/bootstrap/dist')));
app.use(express.static('public'));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'troque-para-uma-senha-segura',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 },
  })
);

// ─── Guards ───────────────────────────────────────────────────────────────────
function ensureSignedIn(req, res, next) {
  if (req.session.user) return next();
  return res.status(401).json({ error: 'Não autenticado' });
}

function ensureAdmin(req, res, next) {
  if (req.session.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Acesso negado' });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!usersCollection) {
    return res.status(503).json({ error: 'Banco de dados não disponível' });
  }

  try {
    const user = await usersCollection.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }

    req.session.user = { username: user.username, role: user.role };
    return res.json({ user: req.session.user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro interno no login' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/auth-status', (req, res) => {
  return res.json({ user: req.session.user || null });
});

// ─── Cadastro de usuário ──────────────────────────────────────────────────────
// Regra: qualquer admin logado pode criar usuários.
// Caso não exista nenhum usuário ainda (bootstrap), permite sem autenticação.
app.post('/register', async (req, res) => {
  if (!usersCollection) {
    return res.status(503).json({ error: 'Banco de dados não disponível' });
  }

  try {
    const totalUsers = await usersCollection.countDocuments();
    const isFirstUser = totalUsers === 0;
    const callerIsAdmin = req.session.user?.role === 'admin';

    if (!isFirstUser && !callerIsAdmin) {
      return res.status(403).json({ error: 'Apenas administradores podem cadastrar usuários' });
    }

    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }

    const allowedRoles = ['admin', 'viewer'];
    const userRole = allowedRoles.includes(role) ? role : 'viewer';

    const hashedPassword = await bcrypt.hash(password, 12);

    await usersCollection.insertOne({
      username,
      password: hashedPassword,
      role: userRole,
      createdAt: new Date(),
    });

    return res.json({ ok: true });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Nome de usuário já existe' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Erro ao cadastrar usuário' });
  }
});

// Lista usuários (somente admin) — útil para gestão futura
app.get('/users', ensureAdmin, async (req, res) => {
  try {
    const list = await usersCollection
      .find({}, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
    return res.json(list.map(({ _id, ...u }) => u));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

// Remove usuário (somente admin, não pode remover a si mesmo)
app.delete('/users/:username', ensureAdmin, async (req, res) => {
  const { username } = req.params;

  if (username === req.session.user.username) {
    return res.status(400).json({ error: 'Você não pode remover a si mesmo' });
  }

  try {
    const result = await usersCollection.deleteOne({ username });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao remover usuário' });
  }
});

// ─── Imagens ──────────────────────────────────────────────────────────────────
app.get('/images', async (req, res) => {
  try {
    let images = [];

    if (imageCollection) {
      // admin vê tudo; usuário logado vê só as suas; não-logado não vê nenhuma
      const sessionUser = req.session.user;
      let query = { uploadedBy: '__none__' }; // padrão: ninguém sem login

      if (sessionUser?.role === 'admin') {
        query = {}; // tudo
      } else if (sessionUser?.username) {
        query = { uploadedBy: sessionUser.username }; // só as suas
      }

      images = await imageCollection.find(query).sort({ uploadDate: -1 }).toArray();
      return res.json(images.map(({ _id, ...doc }) => doc));
    }

    // fallback sem MongoDB: lista bruta do R2 (sem controle de dono)
    const listCommand = new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET });
    const result = await s3.send(listCommand);
    const r2Images = (result.Contents || []).map((item) => ({
      key: item.Key,
      url: `${publicUrl}/${encodeURIComponent(item.Key)}`,
      summary: '',
      location: '',
      photoDate: null,
      uploadDate: item.LastModified || null,
      gps: null,
      uploadedBy: null,
    }));

    res.json(r2Images);
  } catch (error) {
    console.error(error);
    res.status(500).send('Erro ao listar imagens');
  }
});

app.post('/upload', ensureSignedIn, upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Arquivo não enviado' });
  }

  if (!imageCollection) {
    return res.status(500).json({ error: 'MongoDB não está disponível' });
  }

  const summary = (req.body.summary || '').trim();
  const location = (req.body.location || '').trim();
  const photoDate = req.body.photoDate || new Date().toISOString();

  try {
    // Redimensiona para no máximo 1920px e converte para WebP (qualidade 85)
    const processedBuffer = await sharp(req.file.buffer)
      .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    // Nome do arquivo sempre com extensão .webp
    const originalName = req.file.originalname.replace(/\.[^.]+$/, '');
    const key = `${originalName}.webp`;

    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: processedBuffer,
        ContentType: 'image/webp',
      })
    );

    const document = {
      key,
      url: `${publicUrl}/${encodeURIComponent(key)}`,
      uploadDate: new Date(),
      photoDate: new Date(photoDate),
      summary,
      location,
      gps: null,
      uploadedBy: req.session.user.username,
    };

    await imageCollection.updateOne({ key }, { $set: document }, { upsert: true });
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao enviar imagem' });
  }
});

app.delete('/images', ensureSignedIn, async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'Chave da imagem obrigatória' });

  try {
    const decodedKey = decodeURIComponent(key);

    if (imageCollection) {
      const image = await imageCollection.findOne({ key: decodedKey });
      if (!image) return res.status(404).json({ error: 'Imagem não encontrada' });

      const isOwner = image.uploadedBy === req.session.user.username;
      const isAdmin = req.session.user.role === 'admin';

      if (!isOwner && !isAdmin) {
        return res.status(403).json({ error: 'Sem permissão para excluir esta imagem' });
      }
    }

    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: decodedKey }));
    if (imageCollection) await imageCollection.deleteOne({ key: decodedKey });
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao deletar imagem' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function startServer() {
  try {
    await initMongo();
  } catch (error) {
    console.warn('Continuando sem MongoDB conectado:', error.message || error);
  }

  app.listen(port, () => {
    console.log(`Rodando em http://localhost:${port}`);
  });
}

startServer();