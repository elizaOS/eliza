/** Runs the maps domain and provider-contract suites in a Node environment. */
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
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
  },
  resolve: {
    conditions: ["node"],
    alias: [
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(root, "packages/core/src/index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/(.+)$/,
        replacement: path.join(root, "packages/core/src/$1"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(root, "packages/ui/src/$1"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(root, "packages/ui/src/index.ts"),
      },
      {
        find: /^@elizaos\/cloud-routing$/,
        replacement: path.join(root, "packages/cloud/routing/src/index.ts"),
      },
    ],
  },
  ssr: {
    resolve: { conditions: ["node"] },
  },
});
