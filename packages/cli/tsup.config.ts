import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  external: [
    'better-sqlite3', 
    'node:fs',
    '@elizaos/cli/package.json',
    'path',
    'fs',
    'os',
    'crypto',
    'stream',
    'util',
    'events',
    'zlib',
    'buffer',
    'http',
    'https',
    'url',
    'querystring',
    'tty',
    'child_process',
    'worker_threads',
    'readline',
  ],
  platform: 'node',
  minify: false,
  target: "esnext",
  outDir: "dist",
  tsconfig: "tsconfig.json",
  banner: {
    js: `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
`,
  },
})
