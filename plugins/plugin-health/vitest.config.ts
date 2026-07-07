/**
 * Vitest configuration for plugin-health tests, provider SDK shims, and sibling
 * scheduling source aliases.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { providerSdkShimPlugin } from "../../packages/test/vitest/provider-sdk-aliases";

const fromHere = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));

// Cross-plugin gate coverage must exercise the sibling scheduling gate/anchor
// registries from source, not stale dist — so only `@elizaos/plugin-scheduling`
// is pinned to source. `@elizaos/shared` and `@elizaos/tui` deliberately stay
// on their (coreBuild) dist: the smoke test loads the full health plugin, whose
// `HealthView` pulls in `@elizaos/ui`'s dist, which imports ~25 `@elizaos/shared`
// subpaths. Redirecting bare `@elizaos/shared` to source while those subpaths
// resolve to dist splits `shared` across two builds and leaves an export
// undefined at eval time (`Object.keys(undefined)`); keeping shared uniformly on
// dist avoids the split. Provider SDK shims come from `providerSdkShimPlugin()`.
const aliases = [
  {
    find: /^@elizaos\/plugin-scheduling$/,
    replacement: fromHere("../plugin-scheduling/src/index.ts"),
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
