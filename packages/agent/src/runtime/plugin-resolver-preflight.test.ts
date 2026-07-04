/**
 * Regression coverage for the generic plugin `preflight` hook and the
 * name-agnostic static-loader fallback that replaced the resolver's
 * `=== "@elizaos/plugin-browser"` / `=== "@elizaos/plugin-sql"` special cases
 * (#12665). Deterministic: fake plugin modules seeded into the shared static
 * registry, no live model and no disk fixtures.
 *
 * Also asserts (by reading the resolver source) that the two literal
 * plugin-name branches are gone from the executable path — the grep guard the
 * issue requires.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import { resolvePlugins } from "./plugin-resolver.ts";
import {
  STATIC_ELIZA_PLUGIN_LOADERS,
  STATIC_ELIZA_PLUGINS,
} from "./plugin-types.ts";

const thisDir = path.dirname(fileURLToPath(import.meta.url));

// Deny the full default core/view set so the load set is exactly the one plugin
// each test allows. This isolates loadSinglePlugin's behavior for the plugin
// under test from the dozens of real plugins the default config seeds.
async function denyAllDefaultsExcept(allow: string[]): Promise<ElizaConfig> {
  const { CORE_PLUGINS, MOBILE_VIEW_PLUGINS, OPTIONAL_CORE_PLUGINS } =
    await import("./core-plugins.ts");
  const deny = [
    ...CORE_PLUGINS,
    ...MOBILE_VIEW_PLUGINS,
    ...OPTIONAL_CORE_PLUGINS,
  ].filter((name) => !allow.includes(name));
  return {
    plugins: { allow, deny },
  } as unknown as ElizaConfig;
}

const seededRegistryKeys: string[] = [];
const seededLoaderKeys: string[] = [];

function seedStaticPlugin(name: string, plugin: Plugin): void {
  STATIC_ELIZA_PLUGINS[name] = { default: plugin };
  seededRegistryKeys.push(name);
}

function seedStaticLoader(name: string, load: () => Promise<unknown>): void {
  STATIC_ELIZA_PLUGIN_LOADERS[name] = load;
  seededLoaderKeys.push(name);
}

beforeEach(() => {
  seededRegistryKeys.length = 0;
  seededLoaderKeys.length = 0;
});

afterEach(() => {
  for (const key of seededRegistryKeys) delete STATIC_ELIZA_PLUGINS[key];
  for (const key of seededLoaderKeys) delete STATIC_ELIZA_PLUGIN_LOADERS[key];
});

describe("generic plugin preflight hook", () => {
  it("invokes preflight() for a plugin that declares one, before init", async () => {
    const calls: string[] = [];
    const name = "@thirdparty/plugin-preflight-fixture";
    const plugin: Plugin = {
      name,
      description: "preflight fixture",
      preflight: () => {
        calls.push("preflight");
      },
      init: () => {
        calls.push("init");
      },
    };
    seedStaticPlugin(name, plugin);

    const resolved = await resolvePlugins(await denyAllDefaultsExcept([name]));

    expect(resolved.map((p) => p.name)).toContain(name);
    // preflight ran, and ran before init would (init fires later at runtime).
    expect(calls).toEqual(["preflight"]);
  });

  it("resolves a plugin with no preflight without error", async () => {
    const name = "@thirdparty/plugin-no-preflight-fixture";
    const plugin: Plugin = {
      name,
      description: "no-preflight fixture",
      actions: [],
    };
    seedStaticPlugin(name, plugin);

    const resolved = await resolvePlugins(await denyAllDefaultsExcept([name]));

    expect(resolved.map((p) => p.name)).toContain(name);
  });

  it("awaits an async preflight() before completing the load", async () => {
    let preflightDone = false;
    const name = "@thirdparty/plugin-async-preflight-fixture";
    const plugin: Plugin = {
      name,
      description: "async preflight fixture",
      actions: [],
      preflight: async () => {
        await Promise.resolve();
        preflightDone = true;
      },
    };
    seedStaticPlugin(name, plugin);

    const resolved = await resolvePlugins(await denyAllDefaultsExcept([name]));

    expect(resolved.map((p) => p.name)).toContain(name);
    expect(preflightDone).toBe(true);
  });
});

describe("name-agnostic static-loader fallback", () => {
  it("loads a plugin via STATIC_ELIZA_PLUGIN_LOADERS when the registry is empty", async () => {
    let loaderCalls = 0;
    const name = "@thirdparty/plugin-loader-fixture";
    const plugin: Plugin = {
      name,
      description: "static loader fixture",
      actions: [],
    };
    // Registry intentionally NOT seeded — only the on-demand loader is, mirroring
    // the Bun.build TLA race where STATIC_ELIZA_PLUGINS is empty at load time.
    seedStaticLoader(name, async () => {
      loaderCalls += 1;
      return { default: plugin };
    });

    const resolved = await resolvePlugins(await denyAllDefaultsExcept([name]));

    expect(resolved.map((p) => p.name)).toContain(name);
    expect(loaderCalls).toBe(1);
  });

  it("prefers the static registry over the loader when both are present", async () => {
    let loaderCalls = 0;
    const name = "@thirdparty/plugin-registry-wins-fixture";
    const registryPlugin: Plugin = {
      name,
      description: "registry plugin",
      actions: [],
    };
    seedStaticPlugin(name, registryPlugin);
    seedStaticLoader(name, async () => {
      loaderCalls += 1;
      return {
        default: { name, description: "loader plugin", actions: [] } as Plugin,
      };
    });

    const resolved = await resolvePlugins(await denyAllDefaultsExcept([name]));

    expect(resolved.map((p) => p.name)).toContain(name);
    // Registry is the fast path; the loader fallback must not run.
    expect(loaderCalls).toBe(0);
  });
});

describe("no name-keyed special cases remain in the resolver (grep guard)", () => {
  it("plugin-resolver.ts has no === plugin-browser / plugin-sql branches", async () => {
    const source = await readFile(
      path.join(thisDir, "plugin-resolver.ts"),
      "utf8",
    );
    expect(source).not.toContain('=== "@elizaos/plugin-browser"');
    expect(source).not.toContain('=== "@elizaos/plugin-sql"');
    // The generic replacements ARE present.
    expect(source).toContain("STATIC_ELIZA_PLUGIN_LOADERS[pluginName]");
    expect(source).toContain("pluginInstance.preflight?.()");
  });
});
