import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    format: ["esm"],
    dts: true,
    target: "node16",
    external: [
        "mongodb",
        "uuid",
        "@ai16z/eliza",
        "dotenv",
        "fs",
        "path",
        "@reflink/reflink",
        "@node-llama-cpp",
        "https",
        "http",
        "agentkeepalive",
        "@anush008/tokenizers"
    ],
    esbuildOptions(options) {
        options.conditions = ["module"]
    },
});
