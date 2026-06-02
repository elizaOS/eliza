import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const agentApiSourceDir = fileURLToPath(
  new URL("../../packages/agent/src/api/", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/agent\/api\/(.+)$/,
        replacement: `${agentApiSourceDir}$1.ts`,
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
