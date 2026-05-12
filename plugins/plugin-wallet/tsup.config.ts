import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "sdk/index": "src/sdk/index.ts",
    "wallet-action": "src/wallet-action.ts",
    "lib/server-wallet-trade": "src/lib/server-wallet-trade.ts",
  },
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
  outExtension() {
    return { js: ".mjs" };
  },
});
