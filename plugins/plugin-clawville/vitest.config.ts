import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Resolve react + react-dom through @testing-library/react so every consumer —
// the stubbed @elizaos/ui view tests AND the real @elizaos/ui/spatial tri-modal
// test — mounts against a single, version-matched React copy. (Resolving react
// from the plugin's own peer dep yields a different minor than the hoisted
// react-dom, which makes SpatialSurface's hooks throw "Invalid hook call".)
const testingLibraryRequire = createRequire(
  require.resolve("@testing-library/react/package.json"),
);
const reactDir = path.dirname(
  testingLibraryRequire.resolve("react/package.json"),
);
const reactDomDir = path.dirname(
  testingLibraryRequire.resolve("react-dom/package.json"),
);

export default defineConfig({
  root: here,
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^react$/, replacement: reactDir },
      {
        find: /^react\/jsx-runtime$/,
        replacement: testingLibraryRequire.resolve("react/jsx-runtime"),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: testingLibraryRequire.resolve("react/jsx-dev-runtime"),
      },
      { find: /^react-dom$/, replacement: reactDomDir },
      {
        find: /^react-dom\/server$/,
        replacement: testingLibraryRequire.resolve("react-dom/server"),
      },
      {
        find: /^react-dom\/client$/,
        replacement: testingLibraryRequire.resolve("react-dom/client"),
      },
      {
        find: /^react-dom\/test-utils$/,
        replacement: testingLibraryRequire.resolve("react-dom/test-utils"),
      },
      // The view components import @elizaos/ui subpaths (agent-surface). Every
      // test mocks @elizaos/ui, so collapse the subpaths onto the root spec so a
      // single vi.mock("@elizaos/ui") covers them all.
      {
        find: /^@elizaos\/ui\/(agent-surface|api|components(?:\/.*)?|hooks|layouts|state|utils)$/,
        replacement: "@elizaos/ui",
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
    passWithNoTests: true,
    restoreMocks: true,
  },
});
