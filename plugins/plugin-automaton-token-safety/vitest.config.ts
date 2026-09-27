import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.{test,spec}.ts", "src/**/*.{test,spec}.ts"],
  },
  resolve: {
    conditions: ["node"],
    alias: [
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(root, "packages/core/src/index.ts"),
      },
      {
        find: /^@elizaos\/core\/(.+)$/,
        replacement: path.join(root, "packages/core/src/$1"),
      },
    ],
  },
});
