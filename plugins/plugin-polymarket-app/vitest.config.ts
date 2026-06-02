import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const require = createRequire(path.join(repoRoot, "package.json"));

export default defineConfig({
  root: here,
  resolve: {
    alias: [
      {
        find: /^react$/,
        replacement: require.resolve("react"),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: require.resolve("react/jsx-runtime"),
      },
      {
        find: /^react-dom$/,
        replacement: require.resolve("react-dom"),
      },
      {
        find: /^react-dom\/client$/,
        replacement: require.resolve("react-dom/client"),
      },
      {
        find: /^@elizaos\/ui\/agent-surface$/,
        replacement: path.join(
          repoRoot,
          "packages/ui/src/agent-surface/index.ts",
        ),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
    server: {
      deps: {
        inline: [
          "@testing-library/react",
          "@testing-library/dom",
          "react",
          "react-dom",
        ],
      },
    },
  },
});
