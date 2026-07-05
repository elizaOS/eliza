/**
 * Covers resolveRuntimePluginImportSpecifier() (rewriting core app plugins to
 * their /plugin runtime entrypoint while leaving other package roots intact) and
 * resolvePlugins() manifest discovery that auto-enables third-party scoped
 * plugin-* packages via their autoEnable module. Deterministic — a real on-disk
 * fixture package under a temp workspace, no live model.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Plugin } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolvePlugins,
  resolveRuntimePluginImportSpecifier,
} from "./plugin-resolver";
import {
  STATIC_ELIZA_PLUGIN_LOADERS,
  STATIC_ELIZA_PLUGINS,
} from "./plugin-types";

describe("resolveRuntimePluginImportSpecifier", () => {
  it("uses app plugin runtime entrypoints for core app plugins", () => {
    expect(
      resolveRuntimePluginImportSpecifier("@elizaos/plugin-personal-assistant"),
    ).toBe("@elizaos/plugin-personal-assistant/plugin");
    expect(
      resolveRuntimePluginImportSpecifier("@elizaos/plugin-calendar"),
    ).toBe("@elizaos/plugin-calendar/plugin");
  });

  it("keeps regular plugin package roots unchanged", () => {
    expect(resolveRuntimePluginImportSpecifier("@elizaos/plugin-google")).toBe(
      "@elizaos/plugin-google",
    );
  });
});

describe("resolvePlugins manifest discovery", () => {
  it("auto-enables third-party scoped plugin packages with plugin-* names", async () => {
    const previousCwd = process.cwd();
    const previousEnv = process.env.THIRD_PARTY_PLUGIN_ENABLE;
    const workspace = await mkdtemp(
      path.join(tmpdir(), "eliza-plugin-discovery-"),
    );
    const packageRoot = path.join(
      workspace,
      "node_modules",
      "@thirdparty",
      "plugin-tinyplace",
    );

    try {
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@thirdparty/plugin-tinyplace",
          version: "0.0.0-test",
          type: "module",
          exports: {
            ".": "./index.js",
          },
          elizaos: {
            plugin: {
              autoEnableModule: "./auto-enable.js",
            },
          },
        }),
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, "auto-enable.js"),
        "export function shouldEnable(ctx) { return ctx.env.THIRD_PARTY_PLUGIN_ENABLE === '1'; }\n",
        "utf8",
      );
      await writeFile(
        path.join(packageRoot, "index.js"),
        "export default { name: '@thirdparty/plugin-tinyplace', description: 'Third-party plugin test fixture.', views: [] };\n",
        "utf8",
      );

      process.env.THIRD_PARTY_PLUGIN_ENABLE = "1";
      process.chdir(workspace);
      const config = { plugins: { allow: [], entries: {} } };
      const resolved = await resolvePlugins(config, { quiet: true });

      expect(config.plugins.allow).toContain("@thirdparty/plugin-tinyplace");
      expect(resolved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "@thirdparty/plugin-tinyplace" }),
        ]),
      );
    } finally {
      process.chdir(previousCwd);
      if (previousEnv === undefined)
        delete process.env.THIRD_PARTY_PLUGIN_ENABLE;
      else process.env.THIRD_PARTY_PLUGIN_ENABLE = previousEnv;
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("resolvePlugins boot-phase split for model providers (#14038)", () => {
  // A configured model provider is first-turn capability: it must load in the
  // BLOCKING phase (before the runtime reports ready/canRespond), never the
  // deferred wave. Driven through the real resolver with an on-disk drop-in
  // package carrying a model-provider package name, plus a non-provider
  // drop-in proving the deferred wave still owns everything else.
  it("loads a model-provider plugin in the blocking phase and excludes it from the deferred phase", async () => {
    const previousCwd = process.cwd();
    const workspace = await mkdtemp(path.join(tmpdir(), "eliza-plugin-phase-"));
    const dropinsDir = path.join(workspace, "dropin-plugins");
    const writeDropIn = async (dirName: string, packageName: string) => {
      const root = path.join(dropinsDir, dirName);
      await mkdir(root, { recursive: true });
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: packageName,
          version: "0.0.0-test",
          type: "module",
          main: "./index.js",
        }),
        "utf8",
      );
      await writeFile(
        path.join(root, "index.js"),
        `export default { name: ${JSON.stringify(packageName)}, description: "phase-split test fixture.", views: [] };\n`,
        "utf8",
      );
    };

    try {
      // The provider fixture reuses a real PROVIDER_PLUGIN_MAP package name so
      // the phase filter classifies it as a model provider; the plain fixture
      // is an ordinary custom plugin.
      await writeDropIn("deepseek", "@elizaos/plugin-deepseek");
      await writeDropIn("plain", "@dropins/plugin-plainfixture");
      process.chdir(workspace);
      const config = {
        plugins: {
          allow: [],
          entries: {},
          load: { paths: [dropinsDir] },
        },
      };

      const blocking = await resolvePlugins(config, {
        quiet: true,
        phase: "blocking",
      });
      const blockingNames = blocking.map((p) => p.name);
      expect(blockingNames).toContain("@elizaos/plugin-deepseek");
      expect(blockingNames).not.toContain("@dropins/plugin-plainfixture");

      const deferred = await resolvePlugins(config, {
        quiet: true,
        phase: "deferred",
      });
      const deferredNames = deferred.map((p) => p.name);
      expect(deferredNames).not.toContain("@elizaos/plugin-deepseek");
      expect(deferredNames).toContain("@dropins/plugin-plainfixture");
    } finally {
      process.chdir(previousCwd);
      await rm(workspace, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("resolvePlugins mobile blocking-phase loadability gate (#14039)", () => {
  // On mobile the bundle has no node_modules, so the blocking pass may only
  // CLAIM (force-load now / exclude from the deferred pass) a model-provider
  // plugin whose module is already loadable — present in STATIC_ELIZA_PLUGINS
  // or STATIC_ELIZA_PLUGIN_LOADERS. Claiming a provider that
  // ensureStaticPluginsRegisteredByName() could not register (no static entry)
  // strands it: the blocking pass records it claimed but fails to load it, and
  // the deferred pass then excludes it because the shared claimed set says
  // blocking already owns it — dropping the configured provider from BOTH
  // phases and deadlocking readiness on a provider that can never register.
  const PROVIDER = "@elizaos/plugin-anthropic"; // in MOBILE_MODEL_PROVIDER_PLUGINS
  const seededRegistryKeys: string[] = [];
  const seededLoaderKeys: string[] = [];
  let previousPlatform: string | undefined;
  let previousApiKey: string | undefined;

  const fakeProviderPlugin: Plugin = {
    name: PROVIDER,
    description: "mobile loadability gate fixture",
    // A capability field so looksLikePlugin() accepts the seeded module
    // (a bare { name, description } is treated as a provider, not a plugin).
    services: [],
  };

  beforeEach(() => {
    seededRegistryKeys.length = 0;
    seededLoaderKeys.length = 0;
    previousPlatform = process.env.ELIZA_PLATFORM;
    previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ELIZA_PLATFORM = "android";
    process.env.ANTHROPIC_API_KEY = "sk-mobile-loadability-gate-fixture";
  });

  afterEach(() => {
    for (const key of seededRegistryKeys) delete STATIC_ELIZA_PLUGINS[key];
    for (const key of seededLoaderKeys) delete STATIC_ELIZA_PLUGIN_LOADERS[key];
    if (previousPlatform === undefined) delete process.env.ELIZA_PLATFORM;
    else process.env.ELIZA_PLATFORM = previousPlatform;
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
  });

  const config = () =>
    ({
      plugins: { allow: [PROVIDER], entries: {} },
    }) as unknown as import("../config/config.ts").ElizaConfig;

  it("does NOT claim a force-included provider absent from the static bundle at blocking time, so readiness does not deadlock and the deferred pass (once the static wave registers it) still owns it", async () => {
    // No static registration for the provider at BLOCKING time — mirrors
    // ensureStaticPluginsRegisteredByName() failing to bake it into the bundle
    // before the blocking pass runs.
    expect(STATIC_ELIZA_PLUGINS[PROVIDER]).toBeUndefined();
    expect(STATIC_ELIZA_PLUGIN_LOADERS[PROVIDER]).toBeUndefined();

    // eliza.ts force-includes every env-configured provider into the blocking
    // pass; reproduce that here.
    const blocking = await resolvePlugins(config(), {
      quiet: true,
      phase: "blocking",
      forceIncludePluginNames: [PROVIDER],
    });
    const blockingNames = blocking.map((p) => p.name);
    // The not-yet-loadable provider must NOT be force-kept in the blocking set —
    // it cannot register at blocking time on mobile, so readiness cannot wait
    // on it (the deadlock the reviewer flagged).
    expect(blockingNames).not.toContain(PROVIDER);

    // The deferred static wave runs AFTER the blocking pass and registers the
    // provider's module. Because the blocking pass did NOT claim it into the
    // shared claimed set, the deferred pass is free to own it rather than
    // filtering it out — so the provider is not silently dropped from BOTH
    // phases (the regression). Seed the loader to model the static wave growing.
    STATIC_ELIZA_PLUGIN_LOADERS[PROVIDER] = async () => ({
      default: fakeProviderPlugin,
    });
    seededLoaderKeys.push(PROVIDER);

    const deferred = await resolvePlugins(config(), {
      quiet: true,
      phase: "deferred",
    });
    const deferredNames = deferred.map((p) => p.name);
    expect(deferredNames).toContain(PROVIDER);
  }, 120_000);

  it("DOES claim a statically-bundled env-selected provider in the blocking phase (control)", async () => {
    // Provider baked into the bundle — loadable now, so the blocking pass may
    // claim it and the runtime blocks readiness on it (the #14038 invariant).
    STATIC_ELIZA_PLUGINS[PROVIDER] = { default: fakeProviderPlugin };
    seededRegistryKeys.push(PROVIDER);

    const blocking = await resolvePlugins(config(), {
      quiet: true,
      phase: "blocking",
      forceIncludePluginNames: [PROVIDER],
    });
    expect(blocking.map((p) => p.name)).toContain(PROVIDER);

    const deferred = await resolvePlugins(config(), {
      quiet: true,
      phase: "deferred",
    });
    // Claimed by blocking => excluded from deferred (the two phases partition).
    expect(deferred.map((p) => p.name)).not.toContain(PROVIDER);
  }, 120_000);
});
