import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    test: {
        setupFiles: ["./src/test_resources/testSetup.ts"],
        environment: "node",
        globals: true,
        testTimeout: 120000,
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
});
