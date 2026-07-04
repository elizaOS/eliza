/** Vitest config for this plugin's unit tests (node environment, extended timeouts for real file I/O, custom setup file). */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/plugin-inmemorydb$/,
        replacement: path.resolve(here, "../plugin-inmemorydb/index.ts"),
      },
      {
        find: /^@elizaos\/plugin-inmemorydb\/(.+)$/,
        replacement: path.resolve(here, "../plugin-inmemorydb/$1"),
      },
    ],
  },
  test: {
    include: ["*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["./vitest.setup.ts"],
  },
});
