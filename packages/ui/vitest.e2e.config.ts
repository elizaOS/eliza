import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// Slow suite: heavy onboarding `__e2e__` jsdom flows. Capped at 15min so a
// runaway test fails clearly instead of stalling CI. Run via `bun run test:slow`.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["src/**/__e2e__/**/*.test.{ts,tsx}"],
      exclude: ["dist/**", "**/node_modules/**"],
      testTimeout: 900_000,
      hookTimeout: 900_000,
    },
  }),
);
