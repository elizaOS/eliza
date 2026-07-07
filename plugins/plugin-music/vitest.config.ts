/**
 * Vitest configuration for deterministic node-based music plugin tests.
 * `music.test.ts` exercises the real sibling `@elizaos/plugin-suno` handler,
 * whose dist is not built in the keyless Plugin Tests lane — anchor its `.`
 * entry to source so the integration runs against the real handler.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/plugin-suno$/,
        replacement: resolve(rootDir, "../plugin-suno/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["./src/__tests__/core-test-mock.ts"],
  },
});
