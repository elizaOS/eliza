import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// This plugin is not yet symlinked into the repo's node_modules (freshly
// materialized, no `bun install` against the workspace), so a bare
// `require.resolve(...)` from here climbs OUT of the repo tree and lands on a
// different react copy than the one `@elizaos/ui` (dist) and react-dom use —
// the classic mixed-react "Invalid hook call". Anchor every react / react-dom /
// lucide-react resolve at `@elizaos/ui` (a stable in-tree workspace package) so
// the whole render path shares exactly one react copy.
const requireFromUi = createRequire(
  path.join(repoRoot, "packages/ui/package.json"),
);
const reactDir = path.dirname(requireFromUi.resolve("react/package.json"));
const reactDomDir = path.dirname(
  requireFromUi.resolve("react-dom/package.json"),
);
const reactJsxRuntime = requireFromUi.resolve("react/jsx-runtime");
const reactDomClient = requireFromUi.resolve("react-dom/client");
const lucideReactDir = path.dirname(
  requireFromUi.resolve("lucide-react/package.json"),
);

// This is a pure-frontend AppView plugin: no agent routes/actions/services, so
// tests only touch React, `@elizaos/app-core` (stubbed — the real package drags
// the whole API server graph in), and `@elizaos/core` for type-only imports.
// Aliases stay narrow to what this plugin imports; there is no plugin-loader
// fan-out to alias here.
export default defineConfig({
  root: here,
  resolve: {
    alias: [
      {
        find: /^react$/,
        replacement: reactDir,
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: reactJsxRuntime,
      },
      {
        find: /^react-dom$/,
        replacement: reactDomDir,
      },
      {
        find: /^react-dom\/client$/,
        replacement: reactDomClient,
      },
      {
        find: /^lucide-react$/,
        replacement: lucideReactDir,
      },
      {
        find: /^@elizaos\/app-core$/,
        replacement: path.join(here, "__tests__/app-core-shim.ts"),
      },
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(repoRoot, "packages/core/src/index.ts"),
      },
      {
        find: /^@elizaos\/shared$/,
        replacement: path.join(repoRoot, "packages/shared/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "__tests__/**/*.test.ts",
    ],
    exclude: ["dist/**", "node_modules/**"],
  },
});
