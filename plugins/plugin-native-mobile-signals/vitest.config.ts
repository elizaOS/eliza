import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "../../packages/scripts/plugins/plugin-native-mobile-signals/*.test.ts",
    ],
  },
});
