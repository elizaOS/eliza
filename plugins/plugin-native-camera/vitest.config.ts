/**
 * Vitest config for this plugin's unit tests: targets `src` test files under
 * the Node environment; individual files opt into a jsdom environment via a
 * `@vitest-environment` directive when they exercise DOM/MediaDevices APIs.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
