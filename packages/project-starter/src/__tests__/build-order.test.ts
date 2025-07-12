import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { $ } from 'bun';

describe('Build Order Integration Test', () => {
  const rootDir = path.resolve(__dirname, '../..');
  const distDir = path.join(rootDir, 'dist');
  const viteBuildDir = path.join(distDir, 'frontend'); // Vite builds to dist/frontend
  const tsupBuildMarker = path.join(distDir, 'index.js'); // TSup creates this

  beforeAll(async () => {
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

    // Check that both vite and tsup outputs exist
    expect(fs.existsSync(viteBuildDir)).toBe(true);
    expect(fs.existsSync(tsupBuildMarker)).toBe(true);

    // Check vite built frontend files
    const frontendFiles = fs.readdirSync(viteBuildDir);
    expect(frontendFiles.length).toBeGreaterThan(0);

    // Should have HTML entry point
    expect(frontendFiles.some(file => file.endsWith('.html'))).toBe(true);

    // Should have assets directory (CSS/JS files are in assets/)
    expect(frontendFiles.includes('assets')).toBe(true);

    // Verify tsup also produced its expected outputs
    const distFiles = fs.readdirSync(distDir);

    // Should have tsup outputs (index.js)
    expect(distFiles.some(file => file === 'index.js')).toBe(true);

    // Should still have frontend directory
    expect(distFiles.includes('frontend')).toBe(true);
  }, 30000); // 30 second timeout for build process
});