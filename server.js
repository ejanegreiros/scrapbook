require('dotenv').config();
const express = require('express');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const app = express();
const port = 3000;

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

app.use(express.static('public'));

app.get('/images', async (req, res) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
    });

    const data = await s3.send(command);

    const images = (data.Contents || []).map(item => ({
      key: item.Key,
      url: `https://pub-1b9f56270eda4c8cbdb655d80c3c2ab0.r2.dev/${encodeURIComponent(item.Key)}`
      
    }));

    res.json(images);
  } catch (error) {
    console.error(error);
    res.status(500).send('Erro ao listar imagens');
  }
});

app.listen(port, () => {
  console.log(`Rodando em http://localhost:${port}`);
});