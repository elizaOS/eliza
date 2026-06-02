import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const agentApiSourceDir = fileURLToPath(
  new URL("../../packages/agent/src/api/", import.meta.url),
);
const uiAgentSurfaceSource = fileURLToPath(
  new URL("../../packages/ui/src/agent-surface/index.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/agent\/api\/(.+)$/,
        replacement: `${agentApiSourceDir}$1.ts`,
      },
      {
        find: /^@elizaos\/ui\/agent-surface$/,
        replacement: uiAgentSurfaceSource,
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
