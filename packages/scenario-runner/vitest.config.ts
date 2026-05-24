import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const pluginsDir = path.join(repoRoot, "plugins");

// Resolve `@elizaos/plugin-*` to workspace source. The scenario runtime
// transitively loads `@elizaos/agent`'s server, whose `server.ts` carries
// dynamic `import("@elizaos/plugin-…")` specifiers for optional plugins
// (x402, browser, …). `test:server` only runs `build:core`, so those plugins
// have no built `dist/` in CI and Vite's eager dynamic-import resolution fails.
// Aliasing to source makes resolution independent of build order.
// Exact-match only (anchored regex): alias the bare package specifier to its
// source entry without rewriting subpath imports like `@elizaos/plugin-x/foo`,
// which must keep their normal resolution.
const pluginSourceAliases = existsSync(pluginsDir)
  ? readdirSync(pluginsDir)
      .filter((name) => name.startsWith("plugin-"))
      .map((name) => ({
        name,
        replacement: path.join(pluginsDir, name, "src", "index.ts"),
      }))
      .filter(({ replacement }) => existsSync(replacement))
      .map(({ name, replacement }) => ({
        find: new RegExp(`^@elizaos/${name}$`),
        replacement,
      }))
  : [];

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/__tests__/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 180_000,
  },
  resolve: {
    alias: pluginSourceAliases,
  },
});
