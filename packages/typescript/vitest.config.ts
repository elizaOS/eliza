import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      // Playwright e2e specs must be run with `npm run test:e2e` (playwright test), not vitest
      "e2e/**",
    ],
  },
});
