/** Dedicated Vitest entry for the remote-push real delivery check.
 *
 * The regular agent harness excludes `*.real.test.ts` in every lane so live
 * APNs/FCM calls never leak into deterministic package tests. This config keeps
 * the same aliases and setup, then narrows execution to the credential-gated
 * push delivery suite so release evidence can run it explicitly when private
 * provider credentials and enrolled devices are available.
 */
import { defineConfig } from "vitest/config";
import agentConfig from "./vitest.config";

export default defineConfig({
  ...agentConfig,
  test: {
    ...agentConfig.test,
    include: ["src/services/push/push-delivery.real.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
  },
});
