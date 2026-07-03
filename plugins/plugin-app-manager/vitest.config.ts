import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromHere = (relativePath: string) =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/agent/config/paths": fromHere(
        "../../packages/agent/src/config/paths.ts",
      ),
      "@elizaos/agent/services/app-package-modules": fromHere(
        "test/stubs/agent-app-package-modules.ts",
      ),
      "@elizaos/agent/services/overlay-app-presence": fromHere(
        "test/stubs/agent-overlay-app-presence.ts",
      ),
      "@elizaos/agent/services/registry-client-queries": fromHere(
        "test/stubs/agent-registry-client-queries.ts",
      ),
      "@elizaos/auth/atomic-json": fromHere(
        "../../packages/auth/src/atomic-json.ts",
      ),
      "@elizaos/plugin-registry": fromHere("../plugin-registry/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
