/** tsup build config for the Suno plugin (CJS + ESM, @elizaos/core external). */
import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    external: ['@elizaos/core'],
});
