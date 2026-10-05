/** Vitest config for the live e2e suite under test/ — long timeouts for the real dev-stack/CLI runs it drives. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/*.live.e2e.test.ts"],
    testTimeout: 420_000,
    hookTimeout: 60_000,
  },
});
