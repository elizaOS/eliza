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
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "test/**/*.test.ts",
      "test/**/*.test.tsx",
    ],
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
        find: /^@elizaos\/cloud-routing$/,
        replacement: path.join(root, "packages/cloud/routing/src/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/agent-surface$/,
        replacement: path.join(
          root,
          "plugins/plugin-maps/test/shims/ui-agent-surface.ts",
        ),
      },
      {
        find: /^@elizaos\/ui\/state$/,
        replacement: path.join(
          root,
          "plugins/plugin-maps/test/shims/ui-state.ts",
        ),
      },
      {
        find: /^@elizaos\/ui\/events$/,
        replacement: path.join(
          root,
          "plugins/plugin-maps/test/shims/ui-events.ts",
        ),
      },
      {
        find: /^@elizaos\/ui\/app-shell-registry$/,
        replacement: path.join(root, "packages/ui/src/app-shell-registry.ts"),
      },
      {
        find: /^@elizaos\/ui\/api\/csrf-client$/,
        replacement: path.join(
          root,
          "plugins/plugin-maps/test/shims/ui-csrf-client.ts",
        ),
      },
    ],
  },
  ssr: {
    resolve: { conditions: ["node"] },
  },
});
