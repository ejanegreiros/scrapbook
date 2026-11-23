require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const exifr = require('exifr');
const { MongoClient } = require('mongodb');
const {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || /\.hei[cf]$/i.test(file.originalname);
    cb(ok ? null : new Error('Apenas imagens são permitidas'), ok);
  },
});
const isProd = process.env.NODE_ENV === 'production';
// Atrás de proxy HTTPS (Render, Railway, Nginx...) defina TRUST_PROXY=1 para o cookie "secure" funcionar
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
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
const mongoClient = new MongoClient(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 5000 });
const dbName = process.env.MONGO_DB || 'r2_gallery';
const collectionName = process.env.MONGO_COLLECTION || 'images';
const usersCollectionName = 'users';
const commentsCollectionName = 'comments';

let imageCollection;
let usersCollection;
let commentsCollection;

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

  commentsCollection = db.collection(commentsCollectionName);
  await commentsCollection.createIndex({ imageKey: 1 });
  await commentsCollection.createIndex({ createdAt: -1 });

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

  // Garante que o usuário guest (commenter) sempre existe
  const guestExists = await usersCollection.findOne({ username: 'guest' });
  if (!guestExists) {
    const guestPassword = await bcrypt.hash('magnifica', 12);
    await usersCollection.insertOne({
      username: 'guest',
      password: guestPassword,
      role: 'commenter',
      createdAt: new Date(),
    });
    console.log('Usuário guest criado.');
  }

  console.log('MongoDB conectado em', dbName);
}

// ─── Middlewares ──────────────────────────────────────────────────────────────
const assetOrigins = ["'self'", 'https://*.r2.dev'];
try { assetOrigins.push(new URL(publicUrl).origin); } catch { /* publicUrl inválida */ }

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': [...assetOrigins, 'data:', 'blob:', 'https://*.tile.openstreetmap.org'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'worker-src': ["'self'"],
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// Bibliotecas de front-end servidas localmente (sem CDN): mais rápido, funciona offline e cabe na CSP
const vendorDirs = {
  bootstrap: 'bootstrap/dist',
  'bootstrap-icons': 'bootstrap-icons',
  leaflet: 'leaflet/dist',
  flatpickr: 'flatpickr/dist',
  qrcodejs: 'qrcodejs',
  exifr: 'exifr/dist',
  heic2any: 'heic2any/dist',
  'fontsource/inter': '@fontsource-variable/inter',
  'fontsource/fraunces': '@fontsource-variable/fraunces',
};
Object.entries(vendorDirs).forEach(([name, dir]) => {
  app.use(`/vendor/${name}`, express.static(path.join(__dirname, 'node_modules', dir), { maxAge: '30d' }));
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '100kb' }));

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET não definido: usando um segredo aleatório (as sessões são perdidas a cada reinício).');
}
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24, // 24 horas
      httpOnly: true,
      sameSite: 'lax',              // permite cookie após redirect externo (QR code)
      secure: 'auto',               // true automaticamente em HTTPS (use TRUST_PROXY atrás de proxy)
    },
  })
);

// Miniaturas ficam no mesmo bucket, sob o prefixo thumbs/
const thumbKeyFor = key => `thumbs/${key}`;

// ─── Rate limit ───────────────────────────────────────────────────────────────
const limiterOptions = { standardHeaders: 'draft-7', legacyHeaders: false };
const loginLimiter = rateLimit({
  ...limiterOptions, windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true,
  message: { error: 'Muitas tentativas de login. Tente novamente em alguns minutos.' },
});
const qrLimiter = rateLimit({
  ...limiterOptions, windowMs: 15 * 60 * 1000, limit: 20,
  message: 'Muitas tentativas. Tente novamente em alguns minutos.',
});
const commentLimiter = rateLimit({
  ...limiterOptions, windowMs: 60 * 1000, limit: 12,
  message: { error: 'Você está comentando rápido demais. Aguarde um instante.' },
});

// ─── Helpers de validação ─────────────────────────────────────────────────────
const isStr = (v, max = 500) => typeof v === 'string' && v.length <= max;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ─── Guards ───────────────────────────────────────────────────────────────────
function ensureSignedIn(req, res, next) {
  if (req.session.user) return next();
  return res.status(401).json({ error: 'Não autenticado' });
}

function ensureAdmin(req, res, next) {
  if (req.session.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Acesso negado' });
}

function ensureCanComment(req, res, next) {
  const role = req.session.user?.role;
  if (req.session.user) return next();
  const { name, email } = req.body;
  if (name && email) return next();
  return res.status(401).json({ error: 'Informe seu nome e e-mail para comentar' });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  // Só aceita strings: evita injeção NoSQL (ex.: { "username": { "$ne": "" } })
  if (!isStr(username, 100) || !isStr(password, 200) || !username || !password) {
    return res.status(400).json({ error: 'Informe usuário e senha' });
  }

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


// ─── Retorna chave QR apenas para admin (usada para gerar o QR no frontend) ──
app.get('/qr-key', ensureAdmin, (req, res) => {
  const key = process.env.QR_ACCESS_KEY || '';
  if (!key) return res.status(404).json({ error: 'QR_ACCESS_KEY nao configurada no .env' });
  res.json({ key });
});

// ─── Login via QR Code (acesso visitante) ─────────────────────────────────────
app.get('/login-qr', qrLimiter, async (req, res) => {
  const { key } = req.query;

  // 1️⃣ Valida a chave do QR (comparação em tempo constante).
  // Sem QR_ACCESS_KEY configurada o acesso por QR fica desativado
  // (antes, uma requisição sem "key" passava na comparação undefined !== undefined).
  const expectedKey = process.env.QR_ACCESS_KEY;
  if (!expectedKey || !safeEqual(key, expectedKey)) {
    return res.status(403).send('QR Code inválido');
  }

  if (!usersCollection) {
    return res.status(503).send('Banco indisponível');
  }

  try {
    // 2️⃣ Busca o usuário guest já existente
    const user = await usersCollection.findOne({ username: 'guest' });

    if (!user) {
      return res.status(404).send('Usuário guest não encontrado');
    }

    // 3️⃣ Cria a sessão exatamente como no login normal
    req.session.user = {
      username: user.username,
      role: user.role
    };

    // 4️⃣ Salva a sessão explicitamente antes de redirecionar
    // (necessário para que o cookie seja enviado corretamente após redirect externo)
    req.session.save((err) => {
      if (err) {
        console.error('Erro ao salvar sessao:', err);
        return res.status(500).send('Erro ao processar login via QR');
      }
      return res.redirect('/');
    });

  } catch (err) {
    console.error(err);
    return res.status(500).send('Erro ao processar login via QR');
  }
});



// ─── Usuários ─────────────────────────────────────────────────────────────────
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

// ─── Comentários ──────────────────────────────────────────────────────────────
// ─── Stats (resumo para o painel inicial) ──────────────────────────────
app.get('/stats', ensureSignedIn, async (req, res) => {
  try {
    const sessionUser = req.session.user;
    let imgQuery = {};
    if (sessionUser.role === 'admin') {
      imgQuery = { $or: [ { private: { $ne: true } }, { uploadedBy: sessionUser.username } ] };
    } else {
      imgQuery = { private: { $ne: true } };
    }
    const [images, comments] = await Promise.all([
      imageCollection.countDocuments(imgQuery),
      commentsCollection.countDocuments({}),
    ]);
    res.json({ images, comments });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao buscar stats' });
  }
});

app.get('/comments', ensureSignedIn, async (req, res) => {
  const { imageKey } = req.query;
  if (!isStr(imageKey, 300) || !imageKey) return res.status(400).json({ error: 'imageKey obrigatório' });

  if (!commentsCollection) {
    return res.status(503).json({ error: 'MongoDB não disponível' });
  }

  try {
    const comments = await commentsCollection
      .find({ imageKey })
      .sort({ createdAt: 1 })
      .toArray();
    return res.json(comments.map(({ _id, ...c }) => ({ ...c, _id: _id.toString() })));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao buscar comentários' });
  }
});

// ─── Ranking de comentários ───────────────────────────────────────────────────
// Rota estática /comments/counts registrada ANTES de /comments/:id para evitar conflito de rotas.
app.get('/comments/counts', ensureSignedIn, async (req, res) => {
  if (!commentsCollection) {
    return res.status(503).json({ error: 'MongoDB não disponível' });
  }

  try {
    const pipeline = [
      {
        $group: {
          _id: '$imageKey',
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          imageKey: '$_id',
          count: 1,
        },
      },
    ];

    const rows = await commentsCollection.aggregate(pipeline).toArray();

    // Converte array → objeto { [imageKey]: count }
    const counts = {};
    rows.forEach(r => { counts[r.imageKey] = r.count; });

    return res.json(counts);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao calcular ranking' });
  }
});

app.post('/comments', commentLimiter, ensureCanComment, async (req, res) => {
  const { imageKey, text, name, email } = req.body || {};

  if (!isStr(imageKey, 300) || !isStr(text, 1000) || !imageKey || !text.trim()) {
    return res.status(400).json({ error: 'imageKey e text são obrigatórios (texto de até 1000 caracteres)' });
  }
  if ((name != null && !isStr(name, 80)) || (email != null && (!isStr(email, 120) || (email && !EMAIL_RE.test(email))))) {
    return res.status(400).json({ error: 'Nome ou e-mail inválido' });
  }

  if (!commentsCollection) {
    return res.status(503).json({ error: 'MongoDB não disponível' });
  }

  try {
    const sessionUser = req.session.user;

    const comment = {
      imageKey,
      text: text.trim(),
      // admin usa o próprio username; viewer e commenter usam o nome digitado no formulário
      authorName: (sessionUser?.role === 'viewer' || sessionUser?.role === 'commenter')
        ? (name || sessionUser.username)
        : (sessionUser ? sessionUser.username : name),
      authorEmail: (sessionUser?.role === 'viewer' || sessionUser?.role === 'commenter')
        ? (email || null)
        : (sessionUser ? null : email),
      authorRole: sessionUser ? sessionUser.role : 'anonymous',
      createdAt: new Date(),
    };

    const inserted = await commentsCollection.insertOne(comment);
    return res.json({ ok: true, comment: { ...comment, _id: inserted.insertedId.toString() } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao salvar comentário' });
  }
});

app.patch('/comments/:id', ensureAdmin, async (req, res) => {
  const { ObjectId } = require('mongodb');
  const { text } = req.body || {};
  if (!isStr(text, 1000) || !text.trim()) return res.status(400).json({ error: 'Texto obrigatorio (até 1000 caracteres)' });
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const result = await commentsCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { text: text.trim(), editedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Comentário não encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao atualizar comentario' });
  }
});

app.delete('/comments/:id', ensureAdmin, async (req, res) => {
  const { ObjectId } = require('mongodb');
  try {
    const result = await commentsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Comentário não encontrado' });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao remover comentário' });
  }
});

// ─── Imagens ──────────────────────────────────────────────────────────────────
app.get('/images', async (req, res) => {
  try {
    let images = [];

    if (imageCollection) {
      const sessionUser = req.session.user;

      let query = { uploadedBy: '__none__' };

      if (sessionUser?.role === 'admin') {
        // Admin ve todas as imagens (publicas + as proprias privadas)
        query = { $or: [ { private: { $ne: true } }, { uploadedBy: sessionUser.username } ] };
      } else if (sessionUser?.role === 'viewer' || sessionUser?.role === 'commenter') {
        // Viewer/commenter ve apenas imagens publicas
        query = { private: { $ne: true } };
      } else if (sessionUser?.username) {
        query = { uploadedBy: sessionUser.username, private: { $ne: true } };
      }

      images = await imageCollection.find(query).sort({ uploadDate: -1 }).toArray();
      return res.json(images.map(({ _id, ...doc }) => doc));
    }

    // fallback sem MongoDB
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

  const role = req.session.user?.role;
  if (role === 'viewer' || role === 'commenter') {
    return res.status(403).json({ error: 'Seu perfil não permite enviar imagens' });
  }

  if (!imageCollection) {
    return res.status(500).json({ error: 'MongoDB não está disponível' });
  }

  const summary = String(req.body.summary || '').trim().slice(0, 500);
  const location = String(req.body.location || '').trim().slice(0, 120);

  // ── Extrai GPS e data EXIF do buffer ORIGINAL (antes do sharp) ──────────────
  let gps = null;
  let resolvedPhotoDate = req.body.photoDate || null;

  try {
    // exifr suporta HEIC, JPEG e outros formatos nativamente
    const exifData = await exifr.parse(req.file.buffer, {
      gps: true,
      tiff: true,
      heic: true,
      translateValues: true,
      reviveValues: true,
    });

    console.log('EXIF data:', JSON.stringify(exifData));

    if (exifData?.latitude != null && exifData?.longitude != null) {
      gps = {
        lat: parseFloat(exifData.latitude.toFixed(6)),
        lng: parseFloat(exifData.longitude.toFixed(6)),
      };
    }

    if (!resolvedPhotoDate) {
      const exifDate = exifData?.DateTimeOriginal || exifData?.DateTime;
      if (exifDate) {
        resolvedPhotoDate = exifDate instanceof Date ? exifDate.toISOString() : exifDate;
      }
    }
  } catch (e) {
    console.error('Erro ao ler EXIF:', e.message);
  }

  // Fallback: GPS enviado pelo frontend (extraido do HEIC antes da conversao para JPEG)
  if (!gps && req.body.gpsLat && req.body.gpsLng) {
    const lat = parseFloat(req.body.gpsLat);
    const lng = parseFloat(req.body.gpsLng);
    if (!isNaN(lat) && !isNaN(lng)) {
      gps = { lat, lng };
      console.log('GPS via frontend (HEIC):', gps);
    }
  }

  console.log('GPS final:', gps);

  const photoDate = resolvedPhotoDate || new Date().toISOString();
  // ─────────────────────────────────────────────────────────────────────────────

  try {
    // sharp aceita HEIC nativamente (requer libheif instalado no sistema)
    const processedBuffer = await sharp(req.file.buffer, { failOn: 'none' })
      .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    // Miniatura (640px) para a galeria: carrega muito mais rápido que a imagem original
    const thumbBuffer = await sharp(processedBuffer)
      .resize(640, 800, { fit: 'cover', position: 'attention' })
      .webp({ quality: 78 })
      .toBuffer();

    const originalName = req.file.originalname.replace(/\.[^.]+$/, '');
    const key = `${originalName}.webp`;
    const thumbKey = thumbKeyFor(key);

    await Promise.all([
      s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: processedBuffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      })),
      s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: thumbKey,
        Body: thumbBuffer,
        ContentType: 'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      })),
    ]);

    const document = {
      key,
      url: `${publicUrl}/${encodeURIComponent(key)}`,
      thumbUrl: `${publicUrl}/thumbs/${encodeURIComponent(key)}`,
      uploadDate: new Date(),
      photoDate: new Date(photoDate),
      summary,
      location,
      gps,                              // ← coordenadas extraídas do EXIF original
      private: req.body.private === 'true', // imagem visivel apenas para o proprio admin
      uploadedBy: req.session.user.username,
    };

    await imageCollection.updateOne({ key }, { $set: document }, { upsert: true });
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao enviar imagem' });
  }
});

// ─── Editar imagem (admin only) ──────────────────────────────────────────────
app.patch('/images', ensureAdmin, async (req, res) => {
  const { key, summary, location, photoDate, private: priv } = req.body || {};
  if (!isStr(key, 300) || !key) return res.status(400).json({ error: 'key obrigatoria' });
  if ((summary !== undefined && !isStr(summary, 500)) || (location !== undefined && !isStr(location, 120))) {
    return res.status(400).json({ error: 'Texto muito longo ou inválido' });
  }
  if (photoDate && isNaN(new Date(photoDate))) return res.status(400).json({ error: 'Data inválida' });
  try {
    const update = {};
    if (summary  !== undefined) update.summary   = summary.trim();
    if (location !== undefined) update.location  = location.trim();
    if (photoDate !== undefined && photoDate) update.photoDate = new Date(photoDate);
    if (priv     !== undefined) update.private   = priv === true || priv === 'true';
    await imageCollection.updateOne({ key }, { $set: update });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao atualizar imagem' });
  }
});

app.delete('/images', ensureSignedIn, async (req, res) => {
  const key = req.query.key;
  if (!isStr(key, 300) || !key) return res.status(400).json({ error: 'Chave da imagem obrigatória' });

  const role = req.session.user?.role;
  if (role === 'viewer' || role === 'commenter') {
    return res.status(403).json({ error: 'Seu perfil não permite excluir imagens' });
  }

  try {
    const decodedKey = key; // o Express já decodifica a query string

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
    // remove também a miniatura (pode não existir em fotos antigas)
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: thumbKeyFor(decodedKey) })).catch(() => {});
    if (imageCollection) await imageCollection.deleteOne({ key: decodedKey });
    return res.json({ ok: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Erro ao deletar imagem' });
  }
});

// ─── Erros (ex.: upload grande demais ou arquivo que não é imagem) ───────────
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo maior que 25 MB' : 'Erro no envio do arquivo';
    return res.status(400).json({ error: msg });
  }
  if (err?.message === 'Apenas imagens são permitidas') return res.status(400).json({ error: err.message });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Requisição grande demais' });
  console.error(err);
  return res.status(500).json({ error: 'Erro interno' });
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