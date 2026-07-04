/**
 * Vitest config for the live suite (`__tests__/**\/*.live.test.ts`), which hits
 * the real OpenRouter API and boots a real `@elizaos/plugin-sql` runtime. Aliases
 * `@elizaos/core` and `@elizaos/plugin-sql` to workspace source so the live tests
 * run against the checkout rather than built artifacts.
 */
import path from "node:path";
import { defineConfig } from "vitest/config";

const elizaRoot = path.resolve(import.meta.dirname, "../..");
const pluginSqlRoot = path.join(elizaRoot, "plugins", "plugin-sql", "src");
const coreSrc = path.join(elizaRoot, "packages", "core", "src");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(coreSrc, "index.node.ts"),
      },
      { find: /^@elizaos\/core\/(.+)$/, replacement: path.join(coreSrc, "$1") },
      {
        find: /^@elizaos\/plugin-sql$/,
        replacement: path.join(pluginSqlRoot, "index.node.ts"),
      },
      {
        find: /^@elizaos\/plugin-sql\/schema$/,
        replacement: path.join(pluginSqlRoot, "schema", "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-sql\/types$/,
        replacement: path.join(pluginSqlRoot, "types.ts"),
      },
      {
        find: /^@elizaos\/plugin-sql\/(.+)$/,
        replacement: path.join(pluginSqlRoot, "$1"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["__tests__/**/*.live.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
