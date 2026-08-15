/**
 * Vitest configuration for scheduling runner and route tests in a Node
 * environment.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        // The shared boot-config store imports @elizaos/core/client-public,
        // and vite's test-mode resolver misses linked-package subpath exports
        // (same class as the @elizaos/core/edge pins in #19815/#19817).
        find: /^@elizaos\/core\/client-public$/,
        replacement: fileURLToPath(
          new URL("../../packages/core/src/client-public.ts", import.meta.url),
        ),
      },
      {
        // Regex, not a string prefix: a bare string alias for @elizaos/shared
        // would rewrite subpath imports like @elizaos/shared/contracts/x into
        // .../src/index.ts/contracts/x.
        find: /^@elizaos\/shared\/(.+)$/,
        replacement:
          fileURLToPath(new URL("../../packages/shared/src", import.meta.url)) +
          "/$1.ts",
      },
      {
        find: /^@elizaos\/shared$/,
        replacement: fileURLToPath(
          new URL("../../packages/shared/src/index.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "test/**/*.{test,spec}.{ts,tsx}",
    ],
  },
});
