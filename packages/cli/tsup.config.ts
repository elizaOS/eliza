import { defineConfig } from "tsup"

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  external: ['better-sqlite3', 'node:fs'],
  platform: 'node',
  minify: false,
  target: "esnext",
  outDir: "dist",
})
