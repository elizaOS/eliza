/**
 * Vitest configuration for the companion plugin's deterministic mock-device
 * suite (in-process `ws` server; no hardware, no network egress).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["eliza-source"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
