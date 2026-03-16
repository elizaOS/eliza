import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  tsconfig: './tsconfig.build.json', // Use build-specific tsconfig
  sourcemap: true,
  clean: true,
  format: ['esm'],
  dts: true,
  noExternal: ['eventemitter3', 'ipull'], // Only bundle pure JS packages
  external: [
    'dotenv',
    'fs',
    'path',
    'https',
    'http',
    'events',
    '@elizaos/core',
    'zod',
    'node-llama-cpp',
    'onnxruntime-node',
    '@huggingface/transformers',
  ],
});
