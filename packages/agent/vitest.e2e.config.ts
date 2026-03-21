import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/core": path.join(
        packageRoot,
        "..",
        "typescript",
        "dist",
        "node",
        "index.node.js",
      ),
      "@elizaos/skills": path.join(
        packageRoot,
        "test",
        "stubs",
        "empty-module.mjs",
      ),
      "@elizaos/plugin-agent-orchestrator": path.join(
        packageRoot,
        "test",
        "stubs",
        "coding-agent-module.ts",
      ),
      "@elizaos/plugin-coding-agent": path.join(
        packageRoot,
        "test",
        "stubs",
        "coding-agent-module.ts",
      ),
      "@elizaos/plugin-pdf": path.join(
        packageRoot,
        "test",
        "stubs",
        "empty-module.mjs",
      ),
      "@elizaos/plugin-form": path.join(
        packageRoot,
        "test",
        "stubs",
        "empty-module.mjs",
      ),
      "@elizaos/plugin-pi-ai": path.join(
        packageRoot,
        "test",
        "stubs",
        "pi-ai-module.ts",
      ),
      electron: path.join(packageRoot, "test", "stubs", "electron-module.ts"),
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
