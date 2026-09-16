import { build } from "tsup";
await build({
  entry: { index: "src/index.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "neutral",
  target: "es2022",
  dts: true,
  splitting: false,
  clean: true,
});
