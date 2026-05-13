import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export default defineConfig({
  root: here,
  resolve: {
    alias: {
      "@elizaos/core": path.join(repoRoot, "packages/core/src/index.ts"),
      "@elizaos/agent": path.join(repoRoot, "packages/agent/src/index.ts"),
      "@elizaos/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
      "@elizaos/plugin-signal": path.join(
        repoRoot,
        "plugins/plugin-signal/src/index.ts",
      ),
      "@elizaos/plugin-whatsapp": path.join(
        repoRoot,
        "plugins/plugin-whatsapp/src/index.ts",
      ),
      "@elizaos/plugin-computeruse": path.join(
        repoRoot,
        "plugins/plugin-computeruse/src/index.ts",
      ),
      "@elizaos/plugin-workflow": path.join(
        repoRoot,
        "plugins/plugin-workflow/src/index.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
