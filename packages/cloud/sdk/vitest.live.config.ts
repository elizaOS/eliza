/** Vitest config for the live e2e suite (`live.e2e.test.ts`), gated by the `ELIZA_CLOUD_SDK_LIVE` env flags. */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
