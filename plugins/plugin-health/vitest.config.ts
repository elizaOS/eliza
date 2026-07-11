/**
 * Vitest configuration for plugin-health tests, provider SDK shims, and sibling
 * scheduling source aliases.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { providerSdkShimPlugin } from "../../packages/test/vitest/provider-sdk-aliases";

// @elizaos/core, @elizaos/logger, and @ai-sdk/anthropic are shimmed by
// providerSdkShimPlugin() (enforce:"pre" resolveId), so they are intentionally
// absent here. Cross-plugin gate coverage must exercise sibling source, not
// stale dist, hence the source aliases below.
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
];

export default defineConfig({
  plugins: [providerSdkShimPlugin()],
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
