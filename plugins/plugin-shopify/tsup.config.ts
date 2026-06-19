import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "es2022",
  sourcemap: true,
  clean: true,
  dts: {
    compilerOptions: {
      composite: false,
      incremental: false,
    },
  },
  splitting: false,
  external: [/^@elizaos\//],
});
