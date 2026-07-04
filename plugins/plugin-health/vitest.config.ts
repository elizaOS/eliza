/** Vitest config for plugin-health, wiring the shared provider-SDK aliases. */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  providerSdkAliases,
  providerSdkShimPlugin,
} from "../../packages/test/vitest/provider-sdk-aliases";

// Resolve `@elizaos/plugin-scheduling` to its in-repo source so the
// cross-plugin gate-coverage guard (default-packs/gate-coverage.test.ts)
// exercises the sibling package's actual `registerBuiltInGates` — not a
// stale prebuilt `dist` or a hoisted node_modules copy. Keyed on the package
// root so subpath imports still resolve normally.
const aliases = {
  ...providerSdkAliases,
  "@elizaos/tui": fileURLToPath(
    new URL("../../packages/tui/src/index.ts", import.meta.url),
  ),
  "@elizaos/plugin-scheduling": fileURLToPath(
    new URL("../plugin-scheduling/src/index.ts", import.meta.url),
  ),
};

export default defineConfig({
  plugins: [providerSdkShimPlugin()],
  resolve: {
    alias: aliases,
  },
  test: {
    alias: aliases,
    // screen-time range helpers compute from the machine-local start of day;
    // pin the zone so these assertions are deterministic across dev + CI.
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
