import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { $ } from 'bun';
import { getViteOutDir } from './vite-config-utils';

describe('Build Order Integration Test', () => {
  const rootDir = path.resolve(__dirname, '../..');
  const distDir = path.join(rootDir, 'dist');
  let viteBuildDir: string;
  const tsupBuildMarker = path.join(distDir, 'index.js'); // TSup creates this

  beforeAll(async () => {
    // Get the actual vite build directory from config
    const viteOutDirRelative = await getViteOutDir(rootDir);
    viteBuildDir = path.join(rootDir, viteOutDirRelative);

    // Clean dist directory before test
    if (fs.existsSync(distDir)) {
      await fs.promises.rm(distDir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    // Clean up after test
    if (fs.existsSync(distDir)) {
      await fs.promises.rm(distDir, { recursive: true, force: true });
    }
  });

  it('should ensure vite build outputs persist after tsup build', async () => {
    // Run the full build process
    await $`cd ${rootDir} && bun run build`;

    const distFiles = fs.readdirSync(distDir);

    // Should have vite outputs (HTML files)
    expect(distFiles.some((file) => file.endsWith('.html'))).toBe(true);

    // Should have vite manifest (if configured)
    const viteBuildMarker = path.join(viteBuildDir, '.vite', 'manifest.json');
    expect(fs.existsSync(viteBuildMarker)).toBe(true);

    // Should have vite assets directory
    expect(distFiles.includes('assets')).toBe(true);

    // Should have tsup outputs (JS and d.ts files)
    expect(distFiles.some((file) => file === 'index.js')).toBe(true);
    expect(distFiles.some((file) => file === 'index.d.ts')).toBe(true);
  }, 30000); // 30 second timeout for build process
});
