import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    format: ["esm"], // Ensure you're targeting CommonJS
    external: [
        "dotenv", // Externalize dotenv to prevent bundling
        "fs", // Externalize fs to use Node.js built-in module
        "path", // Externalize other built-ins if necessary
        "@reflink/reflink",
        "@node-llama-cpp",
        "https",
        "http",
        "agentkeepalive",
        "buffer", // Add buffer as external dependency
        "bs58", // Add bs58 as external dependency
        "@solana/web3.js", // Add solana web3 as external
        "ethers", // Add ethers as external
        // Add other modules you want to externalize
    ],
    // Add Node.js polyfill for browser APIs
    noExternal: [],
    platform: "node", // Explicitly set platform to node
    target: "node16", // Target Node.js version
    // Add environment variables for buffer
    env: {
        NODE_ENV: "production",
    },
    // Define globals
    define: {
        "global.Buffer": "Buffer",
    },
    // Add banner to inject global assignments
    banner: {
        js: `import { Buffer } from 'buffer';
        globalThis.Buffer = Buffer;`,
    },
});
