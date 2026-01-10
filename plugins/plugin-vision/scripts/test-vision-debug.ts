#!/usr/bin/env tsx

import { createAgent } from '@elizaos/cli';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testVision() {
  console.log('Testing vision plugin...');

  // Load character
  const characterPath = path.join(__dirname, '../characters/visual-assistant.json');
  const character = JSON.parse(fs.readFileSync(characterPath, 'utf-8'));

  // Create agent
  const agent = await createAgent(character);

  // Get vision service
  const visionService = agent.runtime.getService('VISION');
  if (!visionService) {
    console.error('Vision service not found!');
    return;
  }

  console.log('Vision service found:', visionService.constructor.name);

  // Check if Florence-2 is initialized
  const florence2 = (visionService as any).florence2;
  console.log('Florence-2 initialized:', florence2?.isInitialized());

  // Try to capture and describe an image
  console.log('\nCapturing image...');
  const imageBuffer = await (visionService as any).captureImage();
  if (imageBuffer) {
    console.log('Image captured, size:', imageBuffer.length);

    // Try to describe it with Florence-2
    try {
      const result = await florence2.analyzeImage(imageBuffer);
      console.log('Florence-2 result:', result);
    } catch (error) {
      console.error('Florence-2 error:', error);
    }

    // Try to describe it with runtime model
    try {
      const base64Image = imageBuffer.toString('base64');
      const imageUrl = `data:image/jpeg;base64,${base64Image}`;
      const description = await agent.runtime.useModel('IMAGE_DESCRIPTION', imageUrl);
      console.log('Runtime model result:', description);
    } catch (error) {
      console.error('Runtime model error:', error);
    }
  } else {
    console.log('No image captured');
  }

  // Check scene description
  const scene = await (visionService as any).getSceneDescription();
  console.log('\nCurrent scene description:', scene?.description);

  process.exit(0);
}

testVision().catch(console.error);
