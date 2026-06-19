import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const stub = (name: string) =>
  fileURLToPath(new URL(`./test/ui-stubs/${name}.ts`, import.meta.url));

// The view imports @elizaos/ui glue subpaths whose package `exports` map does
// not resolve under vitest's resolver (directory-index subpaths such as
// .../composites/page-panel, plus dist/source condition mismatches). Each is
// replaced wholesale by a vi.mock() factory in the view test, so we alias every
// such specifier to its OWN no-op stub file (distinct files are required —
// vitest dedupes mocks by resolved path, so a shared stub would collapse all
// factories into one). The parser module
// (@elizaos/ui/components/pages/vector-browser-utils) is intentionally NOT
// aliased — it resolves fine and is exercised for real.
const UI_ALIASES: Array<{ find: string; replacement: string }> = [
  { find: "@elizaos/ui/agent-surface", replacement: stub("agent-surface") },
  { find: "@elizaos/ui/api", replacement: stub("api") },
  {
    find: "@elizaos/ui/components/composites/page-panel",
    replacement: stub("page-panel"),
  },
  {
    find: "@elizaos/ui/components/pages/MemoryDetailPanel",
    replacement: stub("MemoryDetailPanel"),
  },
  { find: "@elizaos/ui/components/ui/button", replacement: stub("button") },
  { find: "@elizaos/ui/components/ui/input", replacement: stub("input") },
  { find: "@elizaos/ui/components/ui/select", replacement: stub("select") },
  {
    find: "@elizaos/ui/components/ui/skeleton-layouts",
    replacement: stub("skeleton-layouts"),
  },
  { find: "@elizaos/ui/config", replacement: stub("config") },
  { find: "@elizaos/ui/hooks", replacement: stub("hooks") },
  { find: "@elizaos/ui/layouts", replacement: stub("layouts") },
  { find: "@elizaos/ui/state", replacement: stub("state") },
];

export default defineConfig({
  resolve: { alias: UI_ALIASES },
  test: {
    environment: "node",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "test/**/*.{test,spec}.{ts,tsx}",
    ],
    passWithNoTests: true,
  },
});
