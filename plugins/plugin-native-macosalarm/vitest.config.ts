/** Vitest config for plugin-native-macosalarm: runs the `__tests__/` suite (helper IPC framing, action routing, darwin integration) with `globals: false`. */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    globals: false,
  },
});
