import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  sourcemap: true,
  clean: true,
  dts: true,
  external: [
    // Mark browser automation dependencies as external
    '@browserbasehq/stagehand',
    'playwright',
    'playwright-core',
    'playwright-chromium',
    'playwright-firefox',
    'playwright-webkit',
    '@playwright/test',
    'electron',
    // Also mark native dependencies as external
    'canvas',
    '@napi-rs/canvas',
    'bufferutil',
    'utf-8-validate',
  ],
  noExternal: [
    // Bundle our own modules
    './websocket-client',
    './process-manager',
    './errors',
    './retry',
    './security',
    './plugin',
  ],
});
