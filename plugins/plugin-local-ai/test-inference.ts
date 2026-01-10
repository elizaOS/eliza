#!/usr/bin/env bun
/**
 * Integration test for TypeScript Local AI plugin with actual model inference
 */

import { getLlama, LlamaChatSession } from 'node-llama-cpp';
import path from 'path';
import os from 'os';

const MODELS_DIR = path.join(os.homedir(), '.eliza', 'models');
const SMALL_MODEL = 'tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf';
const EMBEDDING_MODEL = 'bge-small-en-v1.5.Q4_K_M.gguf';

async function testTextGeneration(): Promise<void> {
  console.log('\n🧪 Testing TypeScript Text Generation...');
  console.log('   Model:', SMALL_MODEL);
  
  const modelPath = path.join(MODELS_DIR, SMALL_MODEL);
  console.log('   Path:', modelPath);
  
  const llama = await getLlama();
  console.log('   ✓ Llama loaded');
  
  const model = await llama.loadModel({
    modelPath,
    gpuLayers: 33, // Use GPU for inference
  });
  console.log('   ✓ Model loaded');
  
  const context = await model.createContext({ contextSize: 2048 });
  const session = new LlamaChatSession({ contextSequence: context.getSequence() });
  console.log('   ✓ Session created');
  
  const prompt = 'What is 2 + 2? Answer in one word.';
  console.log('   Prompt:', prompt);
  
  const startTime = Date.now();
  const response = await session.prompt(prompt, { maxTokens: 50 });
  const elapsed = Date.now() - startTime;
  
  console.log('   Response:', response.trim());
  console.log('   Time:', elapsed, 'ms');
  console.log('   ✅ Text Generation PASSED\n');
  
  // Cleanup
  await context.dispose();
  await model.dispose();
}

async function testEmbedding(): Promise<void> {
  console.log('\n🧪 Testing TypeScript Embedding Generation...');
  console.log('   Model:', EMBEDDING_MODEL);
  
  const modelPath = path.join(MODELS_DIR, EMBEDDING_MODEL);
  console.log('   Path:', modelPath);
  
  const llama = await getLlama();
  console.log('   ✓ Llama loaded');
  
  const model = await llama.loadModel({
    modelPath,
    gpuLayers: 0, // Embeddings typically run on CPU
  });
  console.log('   ✓ Embedding model loaded');
  
  const embeddingContext = await model.createEmbeddingContext({
    contextSize: 512,
  });
  console.log('   ✓ Embedding context created');
  
  const text = 'Hello, world!';
  console.log('   Text:', text);
  
  const startTime = Date.now();
  const result = await embeddingContext.getEmbeddingFor(text);
  const elapsed = Date.now() - startTime;
  
  const embedding = [...result.vector];
  console.log('   Dimensions:', embedding.length);
  console.log('   First 5 values:', embedding.slice(0, 5).map(v => v.toFixed(4)));
  console.log('   Time:', elapsed, 'ms');
  console.log('   ✅ Embedding Generation PASSED\n');
  
  // Cleanup
  await embeddingContext.dispose();
  await model.dispose();
}

async function main(): Promise<void> {
  console.log('========================================');
  console.log('TypeScript Local AI Integration Test');
  console.log('========================================');
  console.log('CUDA_VISIBLE_DEVICES:', process.env.CUDA_VISIBLE_DEVICES || '(not set)');
  console.log('Models directory:', MODELS_DIR);
  
  try {
    await testTextGeneration();
    await testEmbedding();
    
    console.log('========================================');
    console.log('✅ ALL TYPESCRIPT TESTS PASSED');
    console.log('========================================');
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

main();

