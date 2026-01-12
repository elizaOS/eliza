#!/usr/bin/env bun
/**
 * Build script for service-starter
 */

import { build } from 'bun';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

async function buildProject() {
  console.log('Building service-starter...');

  // Build TypeScript
  const result = await build({
    entrypoints: ['./src/index.ts'],
    outdir: './dist',
    target: 'node',
    format: 'esm',
    splitting: false,
    sourcemap: 'external',
  });

  if (!result.success) {
    console.error('Build failed:', result.logs);
    process.exit(1);
  }

  // Copy public files
  const publicDir = './public';
  const distPublicDir = './dist/public';
  
  if (existsSync(publicDir)) {
    mkdirSync(distPublicDir, { recursive: true });
    mkdirSync(join(distPublicDir, '.well-known'), { recursive: true });
    
    // Copy agent-card.json
    if (existsSync(join(publicDir, '.well-known/agent-card.json'))) {
      copyFileSync(
        join(publicDir, '.well-known/agent-card.json'),
        join(distPublicDir, '.well-known/agent-card.json')
      );
    }
  }

  console.log('Build complete!');
}

buildProject();
