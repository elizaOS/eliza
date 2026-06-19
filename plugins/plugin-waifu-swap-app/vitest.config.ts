import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// This plugin has no local node_modules, and vitest bundles this config to a
// temp .mjs run under Node — whose resolver climbs to the OUTER workspace's
// node_modules and can pick up a different react major than react-dom resolves
// to (a hooks-dispatcher mismatch). So resolve react/react-dom/jsx straight out
// of the repo's Bun `.bun` store, guaranteeing a single matched copy. Prefer
// the requested major when several are present.
const bunStore = path.join(repoRoot, "node_modules", ".bun");

function storePackageDir(pkg: string, major?: string): string {
  const entries = readdirSync(bunStore).filter((entry) =>
    entry.startsWith(`${pkg}@`),
  );
  const match =
    (major && entries.find((entry) => entry.startsWith(`${pkg}@${major}.`))) ||
    entries[0];
  if (!match) {
    throw new Error(`cannot resolve ${pkg}: not present in ${bunStore}`);
  }
  const dir = path.join(bunStore, match, "node_modules", pkg);
  if (!existsSync(path.join(dir, "package.json"))) {
    throw new Error(`cannot resolve ${pkg}: ${dir} has no package.json`);
  }
  return dir;
}

const reactDir = storePackageDir("react", "19");
const reactDomDir = storePackageDir("react-dom", "19");
const lucideDir = storePackageDir("lucide-react", "1");

// Mirror plugin-hyperliquid-app's config. This is a pure frontend AppView
// plugin: it imports only @elizaos/app-core (shimmed below) and @elizaos/core /
// @elizaos/shared, and its tests mock @elizaos/app-core + @elizaos/ui subpaths
// directly, so the agent plugin-graph aliases hyperliquid carries are not
// needed here.
export default defineConfig({
  root: here,
  resolve: {
    // Dedupe react so a single copy backs both react and react-dom.
    dedupe: ["react", "react-dom"],
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
      // SwapAppView imports icons from lucide-react.
      { find: /^lucide-react$/, replacement: lucideDir },
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
