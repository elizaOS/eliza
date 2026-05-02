import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "@elizaos/core",
    "@solana/web3.js",
    "@solana/spl-token",
    "@orca-so/whirlpools",
    "@orca-so/whirlpools-client",
    "@orca-so/whirlpools-core",
  ],
});
