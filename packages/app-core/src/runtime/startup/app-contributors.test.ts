/**
 * Colocated unit coverage for app-core startup app-route and runtime-hook
 * contributors. Drives the real module: env knobs, id normalization, loader
 * export resolution, skip/merge selection into the real drain, and the generic
 * runtime-hook channel (order, empty queue, optional-unavailable skip, real
 * failure rethrow). Registry and global loader lists are hoisted doubles so
 * skip matching does not boot the live first-party catalog.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import { logger, OptionalAppRoutePluginUnavailableError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apps: [] as Array<{
    id: string;
    npmName?: string;
    launch: {
      routePlugin?: { specifier: string; exportName?: string };
      runtimeHook?: { specifier: string; exportName: string };
    };
  }>,
  globalLoaders: [] as Array<{
    id: string;
    load: () => Plugin | Promise<Plugin>;
  }>,
}));

vi.mock("@elizaos/registry/first-party", () => ({
  loadRegistry: () => ({}),
  getApps: () => mocks.apps,
}));

vi.mock("../app-route-plugin-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../app-route-plugin-registry.ts")>();
  return {
    ...actual,
    listAppRoutePluginLoaders: () => mocks.globalLoaders,
  };
});

vi.mock("../app-route-plugin-registry.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../app-route-plugin-registry.ts")>();
  return {
    ...actual,
    listAppRoutePluginLoaders: () => mocks.globalLoaders,
  };
});

import * as appContributors from "./app-contributors.ts";
import {
  __loadAppRoutePluginFromSpecifierForTest,
  drainRuntimeHookContributors,
  getDeferAppRoutesEnabled,
  getSkippedAppRoutePluginIds,
  normalizeAppRoutePluginId,
  registerAppRoutePlugins,
  registerRuntimeHooks,
} from "./app-contributors.ts";

const SKIP_ENV = "ELIZA_SKIP_APP_ROUTE_PLUGINS";
const DEFER_ENV = "ELIZA_DEFER_APP_ROUTES";

const tempDirs: string[] = [];
let savedSkip: string | undefined;
let savedDefer: string | undefined;

function runtimeStub(): AgentRuntime & {
  routes: Array<{ type: string; path: string }>;
  hookIds?: string[];
} {
  return { routes: [] } as unknown as AgentRuntime & {
    routes: Array<{ type: string; path: string }>;
    hookIds?: string[];
  };
}

function pluginWithRoute(name: string, routePath: string): Plugin {
  return {
    name,
    routes: [{ type: "GET", path: routePath }],
  } as Plugin;
}

async function writeTempModule(source: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "app-contributors-"));
  tempDirs.push(dir);
  const file = path.join(dir, "index.mjs");
  await writeFile(file, source, "utf8");
  return pathToFileURL(file).href;
}

describe("app-contributors exports", () => {
  it("exports the boot knobs, drains, and the test loader hook", () => {
    expect(Object.keys(appContributors).sort()).toEqual([
      "__loadAppRoutePluginFromSpecifierForTest",
      "drainRuntimeHookContributors",
      "getDeferAppRoutesEnabled",
      "getSkippedAppRoutePluginIds",
      "normalizeAppRoutePluginId",
      "registerAppRoutePlugins",
      "registerRuntimeHooks",
    ]);
  });
});

describe("getSkippedAppRoutePluginIds", () => {
  beforeEach(() => {
    savedSkip = process.env[SKIP_ENV];
    delete process.env[SKIP_ENV];
  });

  afterEach(() => {
    if (savedSkip === undefined) {
      delete process.env[SKIP_ENV];
    } else {
      process.env[SKIP_ENV] = savedSkip;
    }
  });

  it("returns an empty set when the knob is unset", () => {
    expect(getSkippedAppRoutePluginIds().size).toBe(0);
  });

  it("returns an empty set for an empty string", () => {
    process.env[SKIP_ENV] = "";
    expect(getSkippedAppRoutePluginIds().size).toBe(0);
  });

  it("returns an empty set for whitespace-only input", () => {
    process.env[SKIP_ENV] = "   \t  ";
    expect(getSkippedAppRoutePluginIds().size).toBe(0);
  });

  it("parses a single trimmed token", () => {
    process.env[SKIP_ENV] = "  wallet  ";
    expect(getSkippedAppRoutePluginIds()).toEqual(new Set(["wallet"]));
  });

  it("parses a comma-separated list, trimming each id and dropping blanks", () => {
    process.env[SKIP_ENV] = "lifeops,training, steward";
    expect(getSkippedAppRoutePluginIds()).toEqual(
      new Set(["lifeops", "training", "steward"]),
    );
  });

  it("drops empty segments from duplicate and trailing commas", () => {
    process.env[SKIP_ENV] = "lifeops,,training,";
    const skipped = getSkippedAppRoutePluginIds();
    expect(skipped).toEqual(new Set(["lifeops", "training"]));
    expect(skipped.has("")).toBe(false);
  });

  it("collapses duplicate tokens through Set semantics", () => {
    process.env[SKIP_ENV] = "wallet,wallet, wallet ";
    expect(getSkippedAppRoutePluginIds()).toEqual(new Set(["wallet"]));
  });

  it("preserves full package ids rather than normalizing at parse time", () => {
    process.env[SKIP_ENV] = "@elizaos/plugin-wallet:ui";
    expect(getSkippedAppRoutePluginIds()).toEqual(
      new Set(["@elizaos/plugin-wallet:ui"]),
    );
  });
});

describe("getDeferAppRoutesEnabled", () => {
  beforeEach(() => {
    savedDefer = process.env[DEFER_ENV];
    delete process.env[DEFER_ENV];
  });

  afterEach(() => {
    if (savedDefer === undefined) {
      delete process.env[DEFER_ENV];
    } else {
      process.env[DEFER_ENV] = savedDefer;
    }
  });

  it("defers when the env map omits the knob", () => {
    expect(getDeferAppRoutesEnabled({})).toBe(true);
  });

  it("defers for empty, truthy, and unknown tokens", () => {
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "" })).toBe(true);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "1" })).toBe(true);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "  1  " })).toBe(true);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "true" })).toBe(true);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "yes" })).toBe(true);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "on" })).toBe(true);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "maybe" })).toBe(true);
  });

  it("opts out only for the four explicit falsy tokens, case-insensitively", () => {
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "0" })).toBe(false);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: " 0 " })).toBe(false);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "false" })).toBe(false);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "FALSE" })).toBe(false);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "no" })).toBe(false);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "NO" })).toBe(false);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "off" })).toBe(false);
    expect(getDeferAppRoutesEnabled({ [DEFER_ENV]: "OFF" })).toBe(false);
  });

  it("reads process.env when the caller omits the env map", () => {
    expect(getDeferAppRoutesEnabled()).toBe(true);
    process.env[DEFER_ENV] = "0";
    expect(getDeferAppRoutesEnabled()).toBe(false);
    process.env[DEFER_ENV] = "true";
    expect(getDeferAppRoutesEnabled()).toBe(true);
  });
});

describe("normalizeAppRoutePluginId", () => {
  it("strips the @elizaos/plugin- prefix", () => {
    expect(
      normalizeAppRoutePluginId("@elizaos/plugin-personal-assistant"),
    ).toBe("personal-assistant");
  });

  it("strips :routes and :ui suffixes after the prefix", () => {
    expect(normalizeAppRoutePluginId("@elizaos/plugin-wallet:ui")).toBe(
      "wallet",
    );
    expect(normalizeAppRoutePluginId("@elizaos/plugin-elizacloud:routes")).toBe(
      "elizacloud",
    );
  });

  it("strips a single trailing -app / -ui / -routes suffix", () => {
    expect(normalizeAppRoutePluginId("hyperliquid-app")).toBe("hyperliquid");
    expect(normalizeAppRoutePluginId("wallet-ui")).toBe("wallet");
    expect(normalizeAppRoutePluginId("documents-routes")).toBe("documents");
    expect(normalizeAppRoutePluginId("foo-ui-app")).toBe("foo-ui");
  });

  it("does not strip a :suffix other than routes or ui", () => {
    expect(normalizeAppRoutePluginId("wallet:setup")).toBe("wallet:setup");
  });

  it("lowercases and trims", () => {
    expect(normalizeAppRoutePluginId("  Hyperliquid-App  ")).toBe(
      "hyperliquid",
    );
  });

  it("is idempotent on an already-short alias", () => {
    expect(normalizeAppRoutePluginId("wallet")).toBe("wallet");
    expect(normalizeAppRoutePluginId("@elizaos/plugin-wallet:ui")).toBe(
      normalizeAppRoutePluginId("wallet"),
    );
  });

  it("normalizes empty and whitespace-only ids to an empty string", () => {
    expect(normalizeAppRoutePluginId("")).toBe("");
    expect(normalizeAppRoutePluginId("   ")).toBe("");
  });

  it("leaves an unscoped id without a recognized suffix unchanged aside from case", () => {
    expect(normalizeAppRoutePluginId("Notes")).toBe("notes");
  });
});

describe("drainRuntimeHookContributors", () => {
  it("no-ops when the contributor queue is empty", async () => {
    await expect(
      drainRuntimeHookContributors(runtimeStub(), []),
    ).resolves.toBeUndefined();
  });

  it("invokes a single contributor with the runtime", async () => {
    const runtime = runtimeStub();
    const invoke = vi.fn().mockResolvedValue(undefined);

    await drainRuntimeHookContributors(runtime, [
      { id: "@elizaos/plugin-example", invoke },
    ]);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(runtime);
  });

  it("invokes every contributor in declared order", async () => {
    const order: string[] = [];

    await drainRuntimeHookContributors(runtimeStub(), [
      {
        id: "a",
        invoke: async () => {
          order.push("a");
        },
      },
      {
        id: "b",
        invoke: async () => {
          order.push("b");
        },
      },
      {
        id: "c",
        invoke: async () => {
          order.push("c");
        },
      },
    ]);

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("skips an optional-unavailable contributor and continues the queue", async () => {
    const after = vi.fn().mockResolvedValue(undefined);

    await expect(
      drainRuntimeHookContributors(runtimeStub(), [
        {
          id: "@elizaos/plugin-missing",
          invoke: () =>
            Promise.reject(
              new OptionalAppRoutePluginUnavailableError(
                "@elizaos/plugin-missing",
              ),
            ),
        },
        { id: "@elizaos/plugin-present", invoke: after },
      ]),
    ).resolves.toBeUndefined();

    expect(after).toHaveBeenCalledOnce();
  });

  it("treats a same-named Error as unavailable even without the class identity", async () => {
    const after = vi.fn().mockResolvedValue(undefined);
    const duck = new Error("optional plugin missing");
    duck.name = "OptionalAppRoutePluginUnavailableError";

    await drainRuntimeHookContributors(runtimeStub(), [
      { id: "missing", invoke: () => Promise.reject(duck) },
      { id: "present", invoke: after },
    ]);

    expect(after).toHaveBeenCalledOnce();
  });

  it("rethrows a real contributor failure and short-circuits the rest", async () => {
    const boom = new Error("hook init blew up");
    const after = vi.fn().mockResolvedValue(undefined);

    await expect(
      drainRuntimeHookContributors(runtimeStub(), [
        { id: "@elizaos/plugin-broken", invoke: () => Promise.reject(boom) },
        { id: "@elizaos/plugin-never", invoke: after },
      ]),
    ).rejects.toThrow(boom);

    expect(after).not.toHaveBeenCalled();
  });

  it("rethrows a non-Error rejection instead of treating it as unavailable", async () => {
    const after = vi.fn().mockResolvedValue(undefined);

    await expect(
      drainRuntimeHookContributors(runtimeStub(), [
        { id: "string-fail", invoke: () => Promise.reject("string-fail") },
        { id: "never", invoke: after },
      ]),
    ).rejects.toBe("string-fail");

    expect(after).not.toHaveBeenCalled();
  });
});

describe("__loadAppRoutePluginFromSpecifierForTest", () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns the named export when it is a plugin", async () => {
    const specifier = await writeTempModule(
      "export const routePlugin = { name: 'named-export-plugin' };\n",
    );

    const plugin = await __loadAppRoutePluginFromSpecifierForTest(
      specifier,
      "routePlugin",
    );

    expect(plugin.name).toBe("named-export-plugin");
  });

  it("throws when the named export is missing or not a plugin", async () => {
    const specifier = await writeTempModule(
      "export const routePlugin = { name: 1 };\nexport const other = { foo: 1 };\n",
    );

    await expect(
      __loadAppRoutePluginFromSpecifierForTest(specifier, "routePlugin"),
    ).rejects.toThrow('Missing plugin export "routePlugin"');
    await expect(
      __loadAppRoutePluginFromSpecifierForTest(specifier, "absent"),
    ).rejects.toThrow('Missing plugin export "absent"');
  });

  it("falls back to the default export when no export name is given", async () => {
    const specifier = await writeTempModule(
      "export default { name: 'default-plugin' };\n",
    );

    const plugin = await __loadAppRoutePluginFromSpecifierForTest(
      specifier,
      undefined,
    );

    expect(plugin.name).toBe("default-plugin");
  });

  it("scans module values for the first plugin when default is not one", async () => {
    const specifier = await writeTempModule(
      "export const flag = false;\nexport const plugin = { name: 'from-values' };\n",
    );

    const plugin = await __loadAppRoutePluginFromSpecifierForTest(
      specifier,
      undefined,
    );

    expect(plugin.name).toBe("from-values");
  });

  it("throws when the module has no plugin export", async () => {
    const specifier = await writeTempModule(
      "export const flag = false;\nexport default 1;\n",
    );

    await expect(
      __loadAppRoutePluginFromSpecifierForTest(specifier, undefined),
    ).rejects.toThrow("No plugin export found");
  });

  it("surfaces a missing package as OptionalAppRoutePluginUnavailableError", async () => {
    await expect(
      __loadAppRoutePluginFromSpecifierForTest(
        "@elizaos/plugin-not-installed-app-contributors-coverage",
        "routePlugin",
      ),
    ).rejects.toBeInstanceOf(OptionalAppRoutePluginUnavailableError);
  });

  it("does not classify a syntax error as optional-unavailable", async () => {
    const specifier = await writeTempModule("export const broken = (\n");

    await expect(
      __loadAppRoutePluginFromSpecifierForTest(specifier, "broken"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        !(err instanceof OptionalAppRoutePluginUnavailableError),
    );
  });
});

describe("registerAppRoutePlugins", () => {
  beforeEach(() => {
    mocks.apps = [];
    mocks.globalLoaders = [];
    savedSkip = process.env[SKIP_ENV];
    delete process.env[SKIP_ENV];
  });

  afterEach(() => {
    mocks.apps = [];
    mocks.globalLoaders = [];
    if (savedSkip === undefined) {
      delete process.env[SKIP_ENV];
    } else {
      process.env[SKIP_ENV] = savedSkip;
    }
    vi.restoreAllMocks();
  });

  it("no-ops when both the registry and global loader queues are empty", async () => {
    const runtime = runtimeStub();
    await expect(registerAppRoutePlugins(runtime)).resolves.toBeUndefined();
    expect(runtime.routes).toEqual([]);
  });

  it("drains a single global loader onto the runtime route table", async () => {
    const load = vi
      .fn()
      .mockResolvedValue(pluginWithRoute("notes-routes", "/api/notes"));
    mocks.globalLoaders = [{ id: "@elizaos/plugin-notes", load }];

    const runtime = runtimeStub();
    await registerAppRoutePlugins(runtime);

    expect(load).toHaveBeenCalledOnce();
    expect(runtime.routes).toEqual([{ type: "GET", path: "/api/notes" }]);
  });

  it("prefixes a loader route path that does not start with a slash", async () => {
    mocks.globalLoaders = [
      {
        id: "slashless",
        load: () => pluginWithRoute("slashless", "api/slashless"),
      },
    ];

    const runtime = runtimeStub();
    await registerAppRoutePlugins(runtime);

    expect(runtime.routes.map((route) => route.path)).toEqual([
      "/api/slashless",
    ]);
  });

  it("skips a loader by full id and still drains the rest", async () => {
    const skippedLoad = vi
      .fn()
      .mockResolvedValue(pluginWithRoute("wallet-ui", "/api/wallet"));
    const keptLoad = vi
      .fn()
      .mockResolvedValue(pluginWithRoute("notes-routes", "/api/notes"));
    mocks.globalLoaders = [
      { id: "@elizaos/plugin-wallet:ui", load: skippedLoad },
      { id: "@elizaos/plugin-notes", load: keptLoad },
    ];
    process.env[SKIP_ENV] = "@elizaos/plugin-wallet:ui";

    const runtime = runtimeStub();
    await registerAppRoutePlugins(runtime);

    expect(skippedLoad).not.toHaveBeenCalled();
    expect(keptLoad).toHaveBeenCalledOnce();
    expect(runtime.routes.map((route) => route.path)).toEqual(["/api/notes"]);
  });

  it("skips a loader by normalized short alias", async () => {
    const skippedLoad = vi
      .fn()
      .mockResolvedValue(pluginWithRoute("wallet-ui", "/api/wallet"));
    const keptLoad = vi
      .fn()
      .mockResolvedValue(pluginWithRoute("notes-routes", "/api/notes"));
    mocks.globalLoaders = [
      { id: "@elizaos/plugin-wallet:ui", load: skippedLoad },
      { id: "@elizaos/plugin-notes", load: keptLoad },
    ];
    process.env[SKIP_ENV] = "wallet";

    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const runtime = runtimeStub();
    await registerAppRoutePlugins(runtime);

    expect(skippedLoad).not.toHaveBeenCalled();
    expect(keptLoad).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      "[eliza] Skipping 1 app route plugin(s) via ELIZA_SKIP_APP_ROUTE_PLUGINS: @elizaos/plugin-wallet:ui",
    );
  });

  it("does not log a skip line when skip tokens match nothing", async () => {
    const load = vi
      .fn()
      .mockResolvedValue(pluginWithRoute("notes-routes", "/api/notes"));
    mocks.globalLoaders = [{ id: "@elizaos/plugin-notes", load }];
    process.env[SKIP_ENV] = "missing-alias";

    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    await registerAppRoutePlugins(runtimeStub());

    expect(load).toHaveBeenCalledOnce();
    expect(
      info.mock.calls.some((call) => String(call[0]).includes("Skipping")),
    ).toBe(false);
  });

  it("lets a later global loader overwrite a registry loader with the same id", async () => {
    mocks.apps = [
      {
        id: "notes",
        npmName: "@elizaos/plugin-notes",
        launch: {
          routePlugin: {
            specifier:
              "@elizaos/plugin-not-installed-app-contributors-coverage",
            exportName: "routePlugin",
          },
        },
      },
    ];
    const load = vi
      .fn()
      .mockResolvedValue(pluginWithRoute("global-notes", "/api/notes-global"));
    mocks.globalLoaders = [{ id: "@elizaos/plugin-notes", load }];

    const runtime = runtimeStub();
    await registerAppRoutePlugins(runtime);

    expect(load).toHaveBeenCalledOnce();
    expect(runtime.routes.map((route) => route.path)).toEqual([
      "/api/notes-global",
    ]);
  });

  it("uses app.id when npmName is absent", async () => {
    mocks.apps = [
      {
        id: "local-notes",
        launch: {
          routePlugin: {
            specifier:
              "@elizaos/plugin-not-installed-app-contributors-coverage",
            exportName: "routePlugin",
          },
        },
      },
    ];
    process.env[SKIP_ENV] = "local-notes";

    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const runtime = runtimeStub();
    await registerAppRoutePlugins(runtime);

    expect(runtime.routes).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      "[eliza] Skipping 1 app route plugin(s) via ELIZA_SKIP_APP_ROUTE_PLUGINS: local-notes",
    );
  });

  it("propagates a real loader failure from the drain", async () => {
    const boom = new Error("route plugin exploded");
    mocks.globalLoaders = [
      {
        id: "broken",
        load: () => Promise.reject(boom),
      },
    ];

    await expect(registerAppRoutePlugins(runtimeStub())).rejects.toThrow(boom);
  });
});

describe("registerRuntimeHooks", () => {
  beforeEach(() => {
    mocks.apps = [];
    mocks.globalLoaders = [];
  });

  afterEach(async () => {
    mocks.apps = [];
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { force: true, recursive: true });
    }
  });

  it("no-ops when no registry app declares a runtimeHook", async () => {
    mocks.apps = [{ id: "no-hook", launch: {} }];
    await expect(registerRuntimeHooks(runtimeStub())).resolves.toBeUndefined();
  });

  it("invokes a registry-declared hook export with the runtime", async () => {
    const specifier = await writeTempModule(`
export function registerHook(runtime) {
  runtime.hookIds = runtime.hookIds ?? [];
  runtime.hookIds.push("hook-a");
}
`);
    mocks.apps = [
      {
        id: "hook-app",
        npmName: "@elizaos/plugin-hook-app",
        launch: {
          runtimeHook: { specifier, exportName: "registerHook" },
        },
      },
    ];

    const runtime = runtimeStub();
    await registerRuntimeHooks(runtime);

    expect(runtime.hookIds).toEqual(["hook-a"]);
  });

  it("skips a hook whose optional plugin is not installed", async () => {
    mocks.apps = [
      {
        id: "missing-hook",
        launch: {
          runtimeHook: {
            specifier:
              "@elizaos/plugin-not-installed-app-contributors-coverage",
            exportName: "registerHook",
          },
        },
      },
    ];

    await expect(registerRuntimeHooks(runtimeStub())).resolves.toBeUndefined();
  });

  it("throws when the named hook export is not a function", async () => {
    const specifier = await writeTempModule(
      "export const registerHook = 42;\n",
    );
    mocks.apps = [
      {
        id: "bad-hook",
        launch: {
          runtimeHook: { specifier, exportName: "registerHook" },
        },
      },
    ];

    await expect(registerRuntimeHooks(runtimeStub())).rejects.toThrow(
      `[eliza] ${specifier} did not export a runtime-hook function "registerHook"`,
    );
  });
});
