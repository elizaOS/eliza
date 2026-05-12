import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    format: ["esm"],
    external: [
        "dotenv",
        "fs",
        "path",
        "https",
        "http",
        "zod",
        "@elizaos/core",
        "viem",
        "@x402/fetch",
        "@x402/evm",
        "@x402/core",
    ],
});
