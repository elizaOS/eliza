/**
 * Runs health tests against real workspace sources with explicit browser-safe UI entries.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";

const sharedSrc = fileURLToPath(
  new URL("../../packages/shared/src", import.meta.url),
);
// Array form with an exact barrel entry AND a separate subpath entry: a bare
// string / exact-only `@elizaos/shared` alias prefix-matches subpaths and
// rewrites `@elizaos/shared/runtime-env` into `.../src/index.ts/runtime-env`
// (ENOTDIR). Each subpath must resolve to its own source module instead.
const aliases = [
  {
    find: /^@elizaos\/shared$/,
    replacement: `${sharedSrc}/index.ts`,
  },
  {
    find: /^@elizaos\/shared\/(.+)$/,
    replacement: `${sharedSrc}/$1`,
  },
  {
    find: /^@elizaos\/plugin-scheduling$/,
    replacement: fileURLToPath(
      new URL("../plugin-scheduling/src/index.ts", import.meta.url),
    ),
  },
  {
    find: /^@elizaos\/ui$/,
    replacement: fileURLToPath(
      new URL("../../packages/ui/src/api/client.ts", import.meta.url),
    ),
  },
  {
    find: /^@elizaos\/ui\/spatial$/,
    replacement: fileURLToPath(
      new URL("../../packages/ui/src/spatial/index.ts", import.meta.url),
    ),
  },
  ...buildWorkspaceSourceAliases(),
];

export default defineConfig({
  resolve: {
    alias: aliases,
  },
  test: {
    alias: aliases,
    // Pin local-day helpers so screen-time assertions match across dev and CI.
    env: { TZ: "America/Los_Angeles" },
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/*.live.test.ts",
      "**/*.e2e.test.ts",
    ],
  },
});
