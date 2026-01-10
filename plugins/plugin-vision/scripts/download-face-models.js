#!/usr/bin/env node

import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_BASE_URL =
  'https://raw.githubusercontent.com/justadudewhohacks/face-api.js-models/master/';
const MODELS_DIR = path.join(__dirname, '..', 'models', 'face-api');

const models = [
  // SSD MobileNetV1 model files
  { folder: 'ssd_mobilenetv1', file: 'ssd_mobilenetv1_model-weights_manifest.json' },
  { folder: 'ssd_mobilenetv1', file: 'ssd_mobilenetv1_model-shard1' },
  { folder: 'ssd_mobilenetv1', file: 'ssd_mobilenetv1_model-shard2' },

  // Face Landmark 68 model files
  { folder: 'face_landmark_68', file: 'face_landmark_68_model-weights_manifest.json' },
  { folder: 'face_landmark_68', file: 'face_landmark_68_model-shard1' },

  // Face Recognition model files
  { folder: 'face_recognition', file: 'face_recognition_model-weights_manifest.json' },
  { folder: 'face_recognition', file: 'face_recognition_model-shard1' },
  { folder: 'face_recognition', file: 'face_recognition_model-shard2' },

  // Face Expression model files
  { folder: 'face_expression', file: 'face_expression_model-weights_manifest.json' },
  { folder: 'face_expression', file: 'face_expression_model-shard1' },

  // Age Gender model files
  { folder: 'age_gender_model', file: 'age_gender_model-weights_manifest.json' },
  { folder: 'age_gender_model', file: 'age_gender_model-shard1' },
];

// Ensure models directory exists
if (!fs.existsSync(MODELS_DIR)) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
}

function downloadFile(modelInfo) {
  return new Promise((resolve, reject) => {
    const url = `${MODELS_BASE_URL + modelInfo.folder}/${modelInfo.file}`;
    const filePath = path.join(MODELS_DIR, modelInfo.file);

    // Skip if already exists
    if (fs.existsSync(filePath)) {
      console.log(`✓ ${modelInfo.file} already exists`);
      resolve();
      return;
    }

    console.log(`Downloading ${modelInfo.file}...`);

    const file = fs.createWriteStream(filePath);

    https
      .get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Handle redirect
          https
            .get(response.headers.location, (redirectResponse) => {
              if (redirectResponse.statusCode !== 200) {
                reject(
                  new Error(`Failed to download ${modelInfo.file}: ${redirectResponse.statusCode}`)
                );
                return;
              }

              redirectResponse.pipe(file);

              file.on('finish', () => {
                file.close();
                console.log(`✓ Downloaded ${modelInfo.file}`);
                resolve();
              });
            })
            .on('error', (err) => {
              fs.unlink(filePath, () => {}); // Delete incomplete file
              reject(err);
            });
        } else if (response.statusCode === 200) {
          response.pipe(file);

          file.on('finish', () => {
            file.close();
            console.log(`✓ Downloaded ${modelInfo.file}`);
            resolve();
          });
        } else {
          reject(new Error(`Failed to download ${modelInfo.file}: ${response.statusCode}`));
        }
      })
      .on('error', (err) => {
        fs.unlink(filePath, () => {}); // Delete incomplete file
        reject(err);
      });
  });
}

async function downloadAllModels() {
  console.log('Downloading face-api.js models...\n');
  console.log('Note: These models are required for face recognition functionality.\n');

  try {
    for (const model of models) {
      await downloadFile(model);
    }
    console.log('\n✅ All models downloaded successfully!');
    console.log(`Models saved to: ${MODELS_DIR}`);
  } catch (error) {
    console.error('\n❌ Error downloading models:', error.message);
    console.error('\nYou can manually download the models from:');
    console.error('https://github.com/justadudewhohacks/face-api.js-models');
    process.exit(1);
  }
}

downloadAllModels();
