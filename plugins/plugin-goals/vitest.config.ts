/**
 * Vitest config for plugin-goals. The alias block anchors the leaf DB subpaths
 * of sibling LifeOps plugins to source so the keyless node test graph
 * (`goals.real-db.test.ts` drives PA's repository) never pulls in React views.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const sourceOf = (relative: string) => resolve(rootDir, relative);

export default defineConfig({
  resolve: {
    // goals.real-db.test.ts drives PA's lifeops/repository.ts, which reads the
    // carved DB schemas/repos/factories from these server-safe plugin subpaths.
    // The package barrels re-export React views (→ @elizaos/ui → react-router)
    // and must never enter the keyless node test graph, so the repository imports
    // the leaf DB modules directly. Those subpaths carry no `bun` export
    // condition, so anchor each to source explicitly (the modules depend only on
    // @elizaos/core + drizzle).
    alias: [
      {
        find: /^@elizaos\/plugin-goals\/db\/schema$/,
        replacement: sourceOf("src/db/schema.ts"),
      },
      {
        find: /^@elizaos\/plugin-reminders\/db\/schema$/,
        replacement: sourceOf("../plugin-reminders/src/db/schema.ts"),
      },
      {
        find: /^@elizaos\/plugin-inbox\/db\/schema$/,
        replacement: sourceOf("../plugin-inbox/src/db/schema.ts"),
      },
      {
        find: /^@elizaos\/plugin-finances\/db\/finances-repository$/,
        replacement: sourceOf(
          "../plugin-finances/src/db/finances-repository.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-health\/health-bridge\/health-records$/,
        replacement: sourceOf(
          "../plugin-health/src/health-bridge/health-records.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-health\/sleep\/sleep-episode-types$/,
        replacement: sourceOf(
          "../plugin-health/src/sleep/sleep-episode-types.ts",
        ),
      },
      {
        // PA's telemetry-mapping (pulled in via lifeops/repository.ts) reads the
        // activity-signal reliability helper from this server-safe leaf module.
        find: /^@elizaos\/plugin-health\/sleep\/source-reliability$/,
        replacement: sourceOf(
          "../plugin-health/src/sleep/source-reliability.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-browser\/schema$/,
        replacement: sourceOf("../plugin-browser/src/schema.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "test/**/*.{test,spec}.{ts,tsx}",
    ],
    // `*.harness.test.ts` boot a real PGLite runtime and need the workspace
    // source aliases from vitest.harness.config.ts — run via `test:harness`.
    exclude: ["**/node_modules/**", "dist/**", "**/*.harness.test.ts"],
  },
});
