/**
 * Vitest config for the Slack plugin: aliases `@slack/*` SDKs to the shared
 * provider-SDK shims so unit tests run offline without a live workspace.
 *
 * `@elizaos/shared` is additionally resolved to source so the production-path
 * test can import the REAL `buildCharacterFromConfig` from `@elizaos/agent`
 * and drive an actual persisted `ElizaConfig` through character projection into
 * the registered Bolt handler. Without it, `packages/shared` would need a built
 * `dist` and the test would have to hand-construct the character, which is
 * precisely the bypass that let the config-projection bug ship.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import {
  providerSdkAliases,
  providerSdkShimPlugin,
} from "../../packages/test/vitest/provider-sdk-aliases";

const here = path.dirname(fileURLToPath(import.meta.url));
const sharedSrc = path.resolve(here, "../../packages/shared/src");

const aliases = [
  ...providerSdkAliases,
  {
    find: /^@elizaos\/shared\/(.+)$/,
    replacement: path.join(sharedSrc, "$1"),
  },
  {
    find: /^@elizaos\/shared$/,
    replacement: path.join(sharedSrc, "index.ts"),
  },
];

export default defineConfig({
  plugins: [providerSdkShimPlugin()],
  resolve: {
    alias: aliases,
  },
  test: {
    alias: aliases,
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
