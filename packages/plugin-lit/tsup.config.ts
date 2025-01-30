import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    format: ["esm"],
    external: [
        // Core dependencies
        "@elizaos/core",
        
        // Lit Protocol dependencies
        "@lit-protocol/lit-node-client",
        "@lit-protocol/contracts-sdk",
        "@lit-protocol/lit-auth-client",
        "@lit-protocol/pkp-ethers",
        
        // Built-in Node.js modules
        "dotenv",
        "fs",
        "path",
        "https",
        "http",
        "events",
        
        // Third-party dependencies
        "@reflink/reflink",
        "@node-llama-cpp",
        "agentkeepalive",
        "viem",
        "@lifi/sdk",
        "node-cache",
        "zod"
    ],
    dts: {
        resolve: true,
        entry: {
            index: "src/index.ts"
        }
    },
    treeshake: true,
    splitting: false,
    bundle: true
});