/** Canonical Vitest factory for keyless real-runtime plugin suites. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "./source-aliases.ts";

export function createPluginRealRuntimeConfig() {
  return defineConfig({
    test: {
      environment: "node",
      include: ["__tests__/**/*.real.test.ts"],
      exclude: ["dist/**", "**/node_modules/**"],
      testTimeout: 120_000,
      hookTimeout: 120_000,
      pool: "forks",
    },
    resolve: { alias: buildWorkspaceSourceAliases() },
  });
}
