/**
 * Runs deterministic component and contribution-scoring tests in a browser-like DOM.
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: [
      "src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.ts",
      "tests/**/*.test.{ts,tsx}",
    ],
  },
});
