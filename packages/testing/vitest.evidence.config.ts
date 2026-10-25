/**
 * Vitest config for @elizaos/testing/evidence: node environment, real-filesystem unit
 * and integration tests under `evidence`. Many tests drive real subprocesses
 * (tesseract, ffmpeg transcodes, Playwright) whose wall-clock depends on host
 * load, so the timeout is sized for a busy CI runner rather than vitest's 5s
 * default — a genuinely hung subprocess is still cut off.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["evidence/**/*.test.ts", "evidence/**/*.test.mjs"],
    exclude: ["**/node_modules/**"],
    testTimeout: 120_000,
  },
});
