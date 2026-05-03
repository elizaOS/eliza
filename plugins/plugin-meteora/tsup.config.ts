import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  tsconfig: "./tsconfig.build.json", // Use build-specific tsconfig
  format: ["esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "@elizaos/core",
    "@solana/web3.js",
    "@noble/curves/ed25519",
    "@noble/hashes/sha256",
    "bigint-buffer",
    "@noble/hashes/sha3",
    "@noble/curves/secp256k1",
  ],
});
