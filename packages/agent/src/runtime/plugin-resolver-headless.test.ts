/**
 * Exercises real app-plugin imports through the agent resolver in a headless
 * Node process. UI dependencies are unavailable; runtime modules and the export
 * normalizer are real, and no model or external service is called.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

it("loads Todos and Relationships without their UI dependency graph", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--conditions=eliza-source",
      "--eval",
      `
        import assert from "node:assert/strict";
        import { registerHooks } from "node:module";
        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (/^(@elizaos\\/ui|react|react-dom)(\\/|$)/.test(specifier)) {
              throw new Error("UI_UNAVAILABLE: " + specifier);
            }
            return nextResolve(specifier, context);
          },
        });
        const { resolveRuntimePluginImportSpecifier } = await import("./packages/agent/src/runtime/plugin-resolver.ts");
        const { findRuntimePluginExport } = await import("./packages/agent/src/runtime/plugin-types.ts");
        for (const name of ["@elizaos/plugin-todos", "@elizaos/plugin-relationships"]) {
          const module = await import(resolveRuntimePluginImportSpecifier(name));
          const descriptor = findRuntimePluginExport(module);
          assert.ok(descriptor, name + " must normalize as a runtime plugin");
          assert.equal(descriptor, module.default);
          assert.ok(descriptor.actions.length > 0);
          assert.ok(descriptor.views.length > 0, name + " must retain dashboard registration");
          await assert.rejects(import(name), /UI_UNAVAILABLE/);
        }
        process.stdout.write("HEADLESS_PLUGINS_LOADED\\n");
        process.exit(0);
      `,
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(output).toContain("HEADLESS_PLUGINS_LOADED");
}, 90_000);
