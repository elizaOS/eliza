import { defineConfig } from "tsup";
export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: false,
    clean: true,
    external: ["@elizaos/core", "@solana/web3.js", "@solana/spl-token"],
});
