require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
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

const users = [
  {
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASS || 'admin123',
    role: 'admin',
  },
  {
    username: process.env.VIEWER_USER || 'viewer',
    password: process.env.VIEWER_PASS || 'viewer123',
    role: 'viewer',
  },
];

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

const publicUrl = process.env.R2_PUBLIC_URL || 'https://pub-1b9f56270eda4c8cbdb655d80c3c2ab0.r2.dev';

const mongoClient = new MongoClient(process.env.MONGO_URI || '');
const dbName = process.env.MONGO_DB || 'r2_gallery';
const collectionName = process.env.MONGO_COLLECTION || 'images';
let imageCollection;

async function initMongo() {
  if (!process.env.MONGO_URI) {
    console.warn('MONGO_URI não definido. MongoDB não será utilizado.');
    return;
  }

  await mongoClient.connect();
  imageCollection = mongoClient.db(dbName).collection(collectionName);
  await imageCollection.createIndex({ key: 1 }, { unique: true });
  console.log('MongoDB conectado em', dbName, '/', collectionName);
}

app.use('/vendor/bootstrap', express.static(path.join(__dirname, 'node_modules/bootstrap/dist')));
app.use(express.static('public'));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'troque-para-uma-senha-segura',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60,
    },
  })
);

function ensureSignedIn(req, res, next) {
  if (req.session.user) {
    return next();
  }

  return res.status(401).json({ error: 'Não autenticado' });
}

function ensureAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }

  return res.status(403).json({ error: 'Acesso negado' });
}

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(
    (entry) => entry.username === username && entry.password === password
  );

  if (!user) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }

  req.session.user = { username: user.username, role: user.role };
  return res.json({ user: req.session.user });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/auth-status', (req, res) => {
  return res.json({ user: req.session.user || null });
});

app.get('/images', async (req, res) => {
  try {
    let images = [];

    if (imageCollection) {
      images = await imageCollection.find().sort({ uploadDate: -1 }).toArray();
    }

    if (images.length > 0) {
      return res.json(images.map(({ _id, ...doc }) => doc));
    }

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
    }));

    res.json(r2Images);
  } catch (error) {
    console.error(error);
    res.status(500).send('Erro ao listar imagens');
  }
});

app.post('/upload', ensureAdmin, upload.single('photo'), async (req, res) => {
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
    const key = req.file.originalname;
    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    });

    await s3.send(command);

    const document = {
      key,
      url: `${publicUrl}/${encodeURIComponent(key)}`,
      uploadDate: new Date(),
      photoDate: new Date(photoDate),
      summary,
      location,
      gps: null,
    };

    await imageCollection.updateOne(
      { key },
      { $set: document },
      { upsert: true }
    );

    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao enviar imagem' });
  }
});

app.delete('/images', ensureAdmin, async (req, res) => {
  const key = req.query.key;
  if (!key) {
    return res.status(400).json({ error: 'Chave da imagem obrigatória' });
  }

  try {
    const decodedKey = decodeURIComponent(key);

    const command = new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: decodedKey,
    });

    await s3.send(command);
    if (imageCollection) {
      await imageCollection.deleteOne({ key: decodedKey });
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao deletar imagem' });
  }
});

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
