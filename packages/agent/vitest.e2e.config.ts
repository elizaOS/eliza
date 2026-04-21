import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(packageRoot, "..", "..");
// See `test/vitest/default.config.ts` (via root vitest.config.ts) for the
// monorepo rationale. Prefer the local
// eliza source; fall back to the committed shim when the checkout is
// disabled (CI published-only mode).
const elizaCoreRolesSource = path.join(
  repoRoot,
  "eliza",
  "packages",
  "typescript",
  "src",
  "roles.ts",
);
const elizaCoreRolesAlias = fs.existsSync(elizaCoreRolesSource)
  ? elizaCoreRolesSource
  : path.join(repoRoot, "scripts", "lib", "elizaos-core-roles-shim.js");

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/core/roles": elizaCoreRolesAlias,
      "@elizaos/core": path.join(
        packageRoot,
        "..",
        "typescript",
        "dist",
        "node",
        "index.node.js",
      ),

    },
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    maxWorkers: 1,
    sequence: {
      concurrent: false,
      shuffle: false,
    },
    include: ["test/**/*.e2e.test.ts"],
    setupFiles: ["test/setup.ts"],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "test/capacitor-plugins.e2e.test.ts",
      // plugin-installer.ts source doesn't exist in autonomous (eliza-specific)
      "test/plugin-install.e2e.test.ts",
      // native module deps (tensorflow, sharp, canvas) not installed in autonomous
      "test/native-modules.e2e.test.ts",
    ],
    server: {
      deps: {
        inline: [
          "@elizaos/core",
          "@elizaos/plugin-openai",
          "@elizaos/plugin-anthropic",
          "@elizaos/plugin-sql",
          "@elizaos/plugin-groq",
          "@elizaos/plugin-google-genai",
          "@elizaos/plugin-xai",
          "@elizaos/plugin-openrouter",
          "zod",
        ],
      },
    },
  },
});
