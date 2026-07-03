import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = path.resolve(here, "../..");
const groundedActionReply = path.join(
  elizaRoot,
  "packages",
  "agent",
  "src",
  "actions",
  "grounded-action-reply.ts",
);
const pluginGoogleSrc = path.join(elizaRoot, "plugins", "plugin-google", "src");
const pluginSqlSrc = path.join(elizaRoot, "plugins", "plugin-sql", "src");
const pluginSchedulingSrc = path.join(
  elizaRoot,
  "plugins",
  "plugin-scheduling",
  "src",
);
const uiSrc = path.join(elizaRoot, "packages", "ui", "src");
const coreSrc = path.join(elizaRoot, "packages", "core", "src");
const loggerSrc = path.join(elizaRoot, "packages", "logger", "src");
const tuiSrc = path.join(elizaRoot, "packages", "tui", "src");
const appCoreNativeLibraryPolicy = path.join(
  elizaRoot,
  "packages",
  "app-core",
  "src",
  "platform",
  "native-library-policy.ts",
);

/**
 * Unit-test config. UI / service suites that need inlined core/agent/ui or
 * plugin-google stubs are layered in alongside their specs; the base here keeps
 * node-environment domain tests fast.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "test/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: [
      "node_modules/**",
      "dist/**",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.real-*.test.{ts,tsx}",
      // #9310 §E: the guarded real/live connector suites (they self-skip
      // without creds) are invocable only in the post-merge lane, where
      // run-all-tests.mjs prints a named skip accounting.
      ...(process.env.VITEST_LANE === "post-merge"
        ? []
        : ["**/*.real.test.{ts,tsx}", "**/*.live.test.{ts,tsx}"]),
      // Integration specs load @elizaos/agent, which (dynamically) pulls the full
      // connector plugin graph. Those connector packages aren't built in the unit
      // Plugin Tests lane, so Node fails to resolve their dist entries. Keep
      // integration specs out of the unit run (they need a full-build lane).
      "**/*.integration.test.{ts,tsx}",
    ],
    server: {
      deps: {
        // @elizaos/agent's built dist dynamically imports every optional
        // connector plugin. Vite 7 import-analysis throws for plugins that
        // aren't built in CI even when @vite-ignore is present. Load @elizaos/agent
        // via Node's native resolver to bypass Vite's transform pipeline.
        external: [/@elizaos\/agent/],
      },
    },
  },
  resolve: {
    alias: [
      {
        find: /^@elizaos\/plugin-google$/,
        replacement: path.join(pluginGoogleSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-google\/(.+)$/,
        replacement: path.join(pluginGoogleSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-sql$/,
        replacement: path.join(pluginSqlSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/plugin-sql\/(.+)$/,
        replacement: path.join(pluginSqlSrc, "$1"),
      },
      {
        find: /^@elizaos\/plugin-scheduling$/,
        replacement: path.join(pluginSchedulingSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/plugin-scheduling\/(.+)$/,
        replacement: path.join(pluginSchedulingSrc, "$1"),
      },
      {
        find: /^@elizaos\/agent$/,
        replacement: groundedActionReply,
      },
      {
        find: /^@elizaos\/app-core\/platform\/native-library-policy$/,
        replacement: appCoreNativeLibraryPolicy,
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(uiSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(uiSrc, "$1"),
      },
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(coreSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/node$/,
        replacement: path.join(coreSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/(.+)$/,
        replacement: path.join(coreSrc, "$1"),
      },
      {
        find: /^@elizaos\/logger$/,
        replacement: path.join(loggerSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/tui$/,
        replacement: path.join(tuiSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/tui\/(.+)$/,
        replacement: path.join(tuiSrc, "$1"),
      },
    ],
  },
});
