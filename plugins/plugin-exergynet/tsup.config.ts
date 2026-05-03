import { defineConfig } from "tsup";

export default defineConfig({
    entry:["src/index.ts"],
    format: ["esm"],
    dts: true, // FIXED: P1 Build-time breakage resolved
    clean: true,
    external:["@elizaos/core", "@solana/web3.js", "@solana/spl-token", "bs58"],
});
