import path from "node:path";
import { defineConfig } from "vitest/config";

const elizaRoot = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(elizaRoot, "packages", "core", "dist", "node", "index.node.js"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.live.test.ts", "**/*.real.test.ts"],
  },
});
