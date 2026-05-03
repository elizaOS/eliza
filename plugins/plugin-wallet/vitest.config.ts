import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    // Live integration tests require dotenv + a real RPC and are opt-in only
    // (run them via a dedicated script, not the default `vitest run`).
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/**/tasks/**",
      "src/**/*.live.test.ts",
      "src/chains/evm/tests/**",
    ],
  },
});
