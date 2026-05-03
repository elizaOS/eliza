import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    exclude: [
      "node_modules",
      "dist",
      "src/actions/__tests__/LpManagementAgentAction.test.ts",
      "src/tasks/__tests__/LpAutoRebalanceTask.test.ts",
      "src/meteora/services/__tests__/MeteoraLpService.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "__tests__/", "dist/", "*.config.*", "coverage/"],
    },
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
