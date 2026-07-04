/**
 * Verifies resolvePlugins() records plugins that import cleanly but export no
 * valid Plugin object, surfaced through the typed getLastFailedPluginNames /
 * getLastFailedPluginDetails accessors (a fresh copy per call) and never stashed
 * on globalThis. Deterministic — a real on-disk fixture package under a temp
 * workspace, no live model.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getLastFailedPluginDetails,
  getLastFailedPluginNames,
  resolvePlugins,
} from "./plugin-resolver";

// Symbols the resolver USED to stash failures on (agent-wide globalThis).
// The seam is now module-owned per-resolve state read via the typed accessors;
// these globals must never be written again (Refs #12091 items 30/31).
const LEGACY_NAMES_SYMBOL = Symbol.for(
  "@elizaos/plugin-resolver/last-failed-plugin-names",
);
const LEGACY_DETAILS_SYMBOL = Symbol.for(
  "@elizaos/plugin-resolver/last-failed-plugin-details",
);

describe("plugin-load failure reporting", () => {
  it("exposes the last resolve pass's failures via the typed accessors without touching globalThis", async () => {
    const previousCwd = process.cwd();
    const previousEnv = process.env.BROKEN_PLUGIN_ENABLE;
    const workspace = await mkdtemp(
      path.join(tmpdir(), "eliza-plugin-failure-"),
    );
    const packageRoot = path.join(
      workspace,
      "node_modules",
      "@thirdparty",
      "plugin-broken",
    );

    try {
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@thirdparty/plugin-broken",
          version: "0.0.0-test",
          type: "module",
          exports: { ".": "./index.js" },
          elizaos: {
            plugin: { autoEnableModule: "./auto-enable.js" },
          },
        }),
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, "auto-enable.js"),
        "export function shouldEnable(ctx) { return ctx.env.BROKEN_PLUGIN_ENABLE === '1'; }\n",
        "utf8",
      );
      // Imports fine but exports no valid Plugin object -> recorded as a failure.
      await writeFile(
        path.join(packageRoot, "index.js"),
        "export const notAPlugin = 1;\n",
        "utf8",
      );

      process.env.BROKEN_PLUGIN_ENABLE = "1";
      process.chdir(workspace);
      const config = { plugins: { allow: [], entries: {} } };
      await resolvePlugins(config, { quiet: true });

      const details = getLastFailedPluginDetails();
      const broken = details.find(
        (d) => d.name === "@thirdparty/plugin-broken",
      );
      expect(broken).toBeDefined();
      expect(broken?.error).toBe("no valid Plugin export");
      expect(getLastFailedPluginNames()).toContain("@thirdparty/plugin-broken");

      // The deleted global is gone: nothing is stashed on globalThis anymore.
      expect(
        (globalThis as Record<symbol, unknown>)[LEGACY_NAMES_SYMBOL],
      ).toBeUndefined();
      expect(
        (globalThis as Record<symbol, unknown>)[LEGACY_DETAILS_SYMBOL],
      ).toBeUndefined();

      // Accessor returns a fresh copy each call — callers cannot mutate state.
      const first = getLastFailedPluginDetails();
      first.push({ name: "mutated", error: "mutated" });
      expect(
        getLastFailedPluginDetails().some((d) => d.name === "mutated"),
      ).toBe(false);
    } finally {
      process.chdir(previousCwd);
      if (previousEnv === undefined) delete process.env.BROKEN_PLUGIN_ENABLE;
      else process.env.BROKEN_PLUGIN_ENABLE = previousEnv;
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
