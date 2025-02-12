import { defineConfig } from "vitest/config.js";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["__tests__/**/*.test.ts"],
        coverage: {
            reporter: ["text", "json", "html"],
        },
    },
});
