/**
 * Runs the opt-in real browser fixture without admitting the broader live,
 * desktop-input, or device lanes excluded by the default package suite.
 */

import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ["src/__tests__/computeruse-browser-fixture.real.e2e.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
  },
});
