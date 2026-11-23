/**
 * Gera miniaturas (640x800, WebP) para as fotos que ainda não têm `thumbUrl`.
 *
 * Uso:  node scripts/generate-thumbs.js          → mostra o que seria feito (dry-run)
 *       node scripts/generate-thumbs.js --apply  → envia as miniaturas ao R2 e grava thumbUrl no MongoDB
 *
 * É seguro rodar várias vezes: só processa fotos sem thumbUrl e nunca altera/apaga a imagem original.
 */
require('dotenv').config();
const sharp = require('sharp');
const { MongoClient } = require('mongodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const apply = process.argv.includes('--apply');
const publicUrl = process.env.R2_PUBLIC_URL || 'https://pub-1b9f56270eda4c8cbdb655d80c3c2ab0.r2.dev';

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY, secretAccessKey: process.env.R2_SECRET_KEY },
});

(async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI não definido');
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const images = client.db(process.env.MONGO_DB || 'r2_gallery').collection(process.env.MONGO_COLLECTION || 'images');

  const pending = await images.find({ thumbUrl: { $exists: false } }).toArray();
  console.log(`${pending.length} foto(s) sem miniatura.${apply ? '' : ' (dry-run: use --apply para gerar)'}`);

  let done = 0, failed = 0;
  for (const doc of pending) {
    const thumbKey = `thumbs/${doc.key}`;
    if (!apply) { console.log(`  • ${doc.key} → ${thumbKey}`); continue; }
    try {
      const res = await fetch(doc.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const input = Buffer.from(await res.arrayBuffer());
      const thumb = await sharp(input, { failOn: 'none' })
        .resize(640, 800, { fit: 'cover', position: 'attention' })
        .webp({ quality: 78 })
        .toBuffer();
      await s3.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET, Key: thumbKey, Body: thumb,
        ContentType: 'image/webp', CacheControl: 'public, max-age=31536000, immutable',
      }));
      await images.updateOne({ _id: doc._id }, { $set: { thumbUrl: `${publicUrl}/thumbs/${encodeURIComponent(doc.key)}` } });
      done++;
      console.log(`  ✓ ${doc.key}`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${doc.key}: ${e.message}`);
    }
  }
  if (apply) console.log(`Concluído: ${done} gerada(s), ${failed} falha(s).`);
  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
