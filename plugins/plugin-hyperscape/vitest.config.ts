import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// react is a peer dep resolvable from the plugin; react-dom is hoisted to the
// monorepo's node_modules/.bun under a content-hashed dir. Resolve react first,
// then locate the react-dom@<version>+<hash> dir that matches it so jsdom mounts
// against a single React copy.
const reactPkgJson = require.resolve("react/package.json");
const reactDir = path.dirname(reactPkgJson);
const reactVersion = require(reactPkgJson).version as string;

function locateBunModulesDir(start: string): string {
  let current = start;
  while (true) {
    const candidate = path.join(current, "node_modules/.bun");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate node_modules/.bun");
    }
    current = parent;
  }
}

const bunModulesDir = locateBunModulesDir(here);
const reactDomEntry = readdirSync(bunModulesDir).find((entry) =>
  entry.startsWith(`react-dom@${reactVersion}+`),
);
if (!reactDomEntry) {
  throw new Error(
    `Unable to locate react-dom@${reactVersion} in ${bunModulesDir}`,
  );
}
const reactDomDir = path.join(
  bunModulesDir,
  reactDomEntry,
  "node_modules/react-dom",
);

export default defineConfig({
  root: here,
  resolve: {
    alias: [
      { find: /^react$/, replacement: reactDir },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.join(reactDir, "jsx-runtime.js"),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: path.join(reactDir, "jsx-dev-runtime.js"),
      },
      { find: /^react-dom$/, replacement: reactDomDir },
      {
        find: /^react-dom\/client$/,
        replacement: path.join(reactDomDir, "client.js"),
      },
      {
        find: /^react-dom\/test-utils$/,
        replacement: path.join(reactDomDir, "test-utils.js"),
      },
      // The view components import @elizaos/ui subpaths (agent-surface). Every
      // test mocks @elizaos/ui, so collapse the subpaths onto the root spec so a
      // single vi.mock("@elizaos/ui") covers them all.
      {
        find: /^@elizaos\/ui\/(agent-surface|api|components(?:\/.*)?|hooks|layouts|state|utils)$/,
        replacement: "@elizaos/ui",
      },
      // Hyperscape surfaces import the surface helpers/client/useApp from
      // @elizaos/app-core/ui-compat. Collapse the subpath onto a single spec so a
      // single vi.mock("@elizaos/app-core/ui-compat") covers them all.
      {
        find: /^@elizaos\/app-core\/ui-compat$/,
        replacement: "@elizaos/app-core/ui-compat",
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
