/**
 * Real-world plugin smoke tests for lifecycle correctness.
 *
 * These tests use synthetic plugins that match the shape of real plugins in
 * this codebase (actions + providers + routes + dispose hooks) but without
 * external service dependencies. They validate the full load/unload contract
 * under conditions that resemble production plugin structure.
 *
 * Note on route paths: the runtime prefixes registered routes with
 * `/<pluginName>` unless the route sets `rawPath: true`. Assertions check
 * for substring inclusion (`.includes(path)`) rather than exact equality.
 */

import { type IAgentRuntime, type Plugin, Service } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { getView } from "../api/views-registry.ts";
import { installRuntimePluginLifecycle } from "../runtime/plugin-lifecycle.ts";
import {
  createTestRuntime,
  type TestRuntime,
} from "./plugin-lifecycle-test-utils.ts";

/** Returns true if the runtime has a registered route whose path includes the given segment. */
function hasRoutePath(routes: { path: string }[], segment: string): boolean {
  return routes.some((r) => r.path.includes(segment));
}

type LifecycleRaceFixture = {
  plugin: Plugin;
  actionName: string;
  routePath: string;
  serviceType: string;
  viewId: string;
};

type InspectableRuntime = TestRuntime & {
  getPluginOwnership: (pluginName: string) => {
    registeredPlugin?: Plugin;
  } | null;
};

function makeLifecycleRaceFixture(
  pluginName: string,
  version: string,
  init?: Plugin["init"],
): LifecycleRaceFixture {
  const token = `${pluginName}-${version}`;
  const actionName = token.replaceAll("-", "_").toUpperCase();
  const routePath = `/api/${token}`;
  const serviceType = `${token}-service`;
  const viewId = `${token}-view`;

  class LifecycleRaceService extends Service {
    static override serviceType = serviceType;
    override capabilityDescription = `Service for ${token}.`;

    static override async start(
      runtime: IAgentRuntime,
    ): Promise<LifecycleRaceService> {
      return new LifecycleRaceService(runtime);
    }

    override async stop(): Promise<void> {}
  }

  return {
    actionName,
    routePath,
    serviceType,
    viewId,
    plugin: {
      name: pluginName,
      description: `Lifecycle race fixture ${token}.`,
      init,
      actions: [
        {
          name: actionName,
          description: "Lifecycle race action.",
          examples: [],
          similes: [],
          validate: async () => true,
          handler: async () => ({ success: true }),
        },
      ],
      routes: [
        {
          type: "GET",
          path: routePath,
          rawPath: true,
          handler: async (_req, res) => {
            res.json({ ok: true });
          },
        },
      ],
      services: [LifecycleRaceService],
      views: [{ id: viewId, label: `Lifecycle ${version}` }],
    },
  };
}

function expectFixtureComponentsAbsent(
  runtime: TestRuntime,
  fixture: LifecycleRaceFixture,
): void {
  expect(
    runtime.actions.some((action) => action.name === fixture.actionName),
  ).toBe(false);
  expect(hasRoutePath(runtime.routes, fixture.routePath)).toBe(false);
  expect(runtime.hasService(fixture.serviceType)).toBe(false);
  expect(getView(fixture.viewId)).toBeUndefined();
}

function expectFixturePresent(
  runtime: InspectableRuntime,
  fixture: LifecycleRaceFixture,
): void {
  expect(
    runtime.plugins.filter((plugin) => plugin.name === fixture.plugin.name),
  ).toEqual([fixture.plugin]);
  expect(
    runtime.actions.some((action) => action.name === fixture.actionName),
  ).toBe(true);
  expect(hasRoutePath(runtime.routes, fixture.routePath)).toBe(true);
  expect(runtime.hasService(fixture.serviceType)).toBe(true);
  expect(getView(fixture.viewId)).toMatchObject({
    pluginName: fixture.plugin.name,
  });
  expect(
    runtime.getPluginOwnership(fixture.plugin.name)?.registeredPlugin,
  ).toBe(fixture.plugin);
}

function expectPluginAbsent(
  runtime: InspectableRuntime,
  fixture: LifecycleRaceFixture,
): void {
  expect(
    runtime.plugins.some((plugin) => plugin.name === fixture.plugin.name),
  ).toBe(false);
  expectFixtureComponentsAbsent(runtime, fixture);
  expect(runtime.getPluginOwnership(fixture.plugin.name)).toBeNull();
}

function installFallbackLifecycle(runtime: TestRuntime): void {
  const internal = runtime as TestRuntime & {
    __elizaPluginLifecycleInstalled?: boolean;
    __elizaPluginViewSyncInstalled?: boolean;
  };
  delete internal.__elizaPluginLifecycleInstalled;
  delete internal.__elizaPluginViewSyncInstalled;
  installRuntimePluginLifecycle(runtime);
}

/**
 * Returns a plugin shaped like the agent-skills plugin:
 * multiple actions, multiple providers, one omitted service (to
 * avoid DB dependency), and a dispose hook.
 */
function makeSyntheticSkillsPlugin(): Plugin {
  return {
    name: "synthetic-skills-plugin",
    description: "Synthetic plugin matching agent-skills structure",
    actions: [
      {
        name: "USE_SKILL",
        description: "Invoke an enabled skill by slug",
        examples: [],
        similes: ["run skill", "execute skill"],
        validate: async () => true,
        handler: async () => ({
          success: true,
          data: { result: "skill-output" },
        }),
      },
      {
        name: "SKILL",
        description: "Manage skills",
        examples: [],
        similes: [],
        validate: async () => true,
        handler: async () => ({ success: true, data: { skills: [] } }),
      },
    ],
    providers: [
      {
        name: "ENABLED_SKILLS_PROVIDER",
        description: "Lists enabled skills for the planner",
        get: async () => ({ text: "no skills enabled" }),
      },
      {
        name: "SKILLS_SUMMARY_PROVIDER",
        description: "Summary of installed skills",
        get: async () => ({ text: "0 skills installed" }),
      },
    ],
    routes: [
      {
        type: "GET",
        path: "/api/skills/catalog",
        rawPath: true,
        handler: async (_req, res) => {
          res.json({ skills: [] });
        },
      },
      {
        type: "POST",
        path: "/api/skills/enable",
        rawPath: true,
        handler: async (_req, res) => {
          res.json({ ok: true });
        },
      },
    ],
    dispose: async () => {
      // Production variant would stop a background sync task here.
    },
  };
}

/**
 * Returns a plugin shaped like an app plugin:
 * routes, one action, and app metadata.
 */
function makeSyntheticAppPlugin(): Plugin {
  return {
    name: "synthetic-app-plugin",
    description: "Synthetic plugin matching app plugin structure",
    actions: [
      {
        name: "APP_ACTION",
        description: "An app-level action",
        examples: [],
        similes: [],
        validate: async () => true,
        handler: async () => ({ success: true, data: { done: true } }),
      },
    ],
    routes: [
      {
        type: "GET",
        path: "/api/app/status",
        rawPath: true,
        handler: async (_req, res) => {
          res.json({ status: "running" });
        },
      },
    ],
    app: {
      displayName: "Synthetic App",
      category: "productivity",
    },
  };
}

/**
 * Returns a plugin shaped like a connector plugin:
 * events, one action.
 */
function makeSyntheticConnectorPlugin(): Plugin {
  return {
    name: "synthetic-connector-plugin",
    description: "Synthetic plugin matching connector plugin structure",
    actions: [
      {
        name: "SEND_MESSAGE",
        description: "Send a message via this connector",
        examples: [],
        similes: ["message", "send"],
        validate: async () => true,
        handler: async () => ({ success: true, data: { sent: true } }),
      },
    ],
    events: {
      MESSAGE_RECEIVED: [
        async () => {
          // Handle incoming message
        },
      ],
    },
    dispose: async () => {
      // Would close WebSocket / disconnect in production
    },
  };
}

describe("skills-shaped plugin — 3 load/unload cycles", () => {
  it("runs 3 cycles and restores baseline state each time", async () => {
    const runtime = createTestRuntime();
    const plugin = makeSyntheticSkillsPlugin();

    const baselineActions = runtime.actions.length;
    const baselineProviders = runtime.providers.length;
    const baselineRoutes = runtime.routes.length;

    for (let cycle = 1; cycle <= 3; cycle++) {
      await runtime.registerPlugin(plugin);

      expect(runtime.actions.some((a) => a.name === "USE_SKILL")).toBe(true);
      expect(runtime.actions.some((a) => a.name === "SKILL")).toBe(true);
      expect(
        runtime.providers.some((p) => p.name === "ENABLED_SKILLS_PROVIDER"),
      ).toBe(true);
      expect(hasRoutePath(runtime.routes, "/api/skills/catalog")).toBe(true);

      await runtime.unloadPlugin("synthetic-skills-plugin");

      expect(runtime.actions.some((a) => a.name === "USE_SKILL")).toBe(false);
      expect(runtime.actions.some((a) => a.name === "SKILL")).toBe(false);
      expect(
        runtime.providers.some((p) => p.name === "ENABLED_SKILLS_PROVIDER"),
      ).toBe(false);
      expect(hasRoutePath(runtime.routes, "/api/skills/catalog")).toBe(false);

      expect(runtime.actions.length).toBe(baselineActions);
      expect(runtime.providers.length).toBe(baselineProviders);
      expect(runtime.routes.length).toBe(baselineRoutes);
    }
  });
});

describe("app-shaped plugin — 3 load/unload cycles", () => {
  it("runs 3 cycles and restores baseline state each time", async () => {
    const runtime = createTestRuntime();
    const plugin = makeSyntheticAppPlugin();

    const baselineActions = runtime.actions.length;
    const baselineRoutes = runtime.routes.length;

    for (let cycle = 1; cycle <= 3; cycle++) {
      await runtime.registerPlugin(plugin);

      expect(runtime.actions.some((a) => a.name === "APP_ACTION")).toBe(true);
      expect(hasRoutePath(runtime.routes, "/api/app/status")).toBe(true);

      await runtime.unloadPlugin("synthetic-app-plugin");

      expect(runtime.actions.some((a) => a.name === "APP_ACTION")).toBe(false);
      expect(hasRoutePath(runtime.routes, "/api/app/status")).toBe(false);

      expect(runtime.actions.length).toBe(baselineActions);
      expect(runtime.routes.length).toBe(baselineRoutes);
    }
  });
});

describe("connector-shaped plugin — 3 load/unload cycles", () => {
  it("event handlers are registered and removed each cycle", async () => {
    const runtime = createTestRuntime();
    const plugin = makeSyntheticConnectorPlugin();

    for (let cycle = 1; cycle <= 3; cycle++) {
      await runtime.registerPlugin(plugin);

      expect(runtime.actions.some((a) => a.name === "SEND_MESSAGE")).toBe(true);
      expect(runtime.events.MESSAGE_RECEIVED?.length ?? 0).toBeGreaterThan(0);

      await runtime.unloadPlugin("synthetic-connector-plugin");

      expect(runtime.actions.some((a) => a.name === "SEND_MESSAGE")).toBe(
        false,
      );
      expect(runtime.events.MESSAGE_RECEIVED?.length ?? 0).toBe(0);
    }
  });
});

describe("mixed plugins — two plugins coexist, one unloads cleanly", () => {
  it("unloading one plugin does not affect a different plugin's registered components", async () => {
    const runtime = createTestRuntime();
    const skills = makeSyntheticSkillsPlugin();
    const app = makeSyntheticAppPlugin();

    await runtime.registerPlugin(skills);
    await runtime.registerPlugin(app);

    expect(runtime.actions.some((a) => a.name === "USE_SKILL")).toBe(true);
    expect(runtime.actions.some((a) => a.name === "APP_ACTION")).toBe(true);

    // Unload only the skills plugin
    await runtime.unloadPlugin("synthetic-skills-plugin");

    expect(runtime.actions.some((a) => a.name === "USE_SKILL")).toBe(false);
    expect(runtime.actions.some((a) => a.name === "APP_ACTION")).toBe(true);
    expect(hasRoutePath(runtime.routes, "/api/app/status")).toBe(true);
  });
});

describe("schema-bearing plugin registration", () => {
  it("runs plugin migrations before publishing a schema plugin against a ready adapter", async () => {
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);
    const lifecycle: string[] = [];
    const runPluginMigrations = vi.fn(async () => {
      lifecycle.push("migration");
      expect(
        runtime.plugins.some((plugin) => plugin.name === "schema-ready-plugin"),
      ).toBe(false);
      expect(
        runtime.actions.some((action) => action.name === "SCHEMA_READY_ACTION"),
      ).toBe(false);
    });

    runtime.registerDatabaseAdapter({
      isReady: async () => true,
      runPluginMigrations,
    } as never);

    await runtime.registerPlugin({
      name: "schema-ready-plugin",
      description: "plugin with a database schema",
      schema: {
        widgets: {
          id: "text",
        },
      },
      init: async () => {
        lifecycle.push("init");
      },
      actions: [
        {
          name: "SCHEMA_READY_ACTION",
          description: "action",
          examples: [],
          similes: [],
          validate: async () => true,
          handler: async () => ({ success: true }),
        },
      ],
    });

    expect(lifecycle).toEqual(["migration", "init"]);
    expect(runPluginMigrations).toHaveBeenCalledOnce();
    expect(runPluginMigrations).toHaveBeenCalledWith(
      [
        {
          name: "schema-ready-plugin",
          schema: {
            widgets: {
              id: "text",
            },
          },
        },
      ],
      {
        verbose: true,
        force: false,
        dryRun: false,
      },
    );
  });

  it("skips schema migration while the adapter is not ready", async () => {
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);
    const runPluginMigrations = vi.fn(async () => {});

    runtime.registerDatabaseAdapter({
      isReady: async () => false,
      runPluginMigrations,
    } as never);

    await runtime.registerPlugin({
      name: "schema-not-ready-plugin",
      description: "plugin with a database schema",
      schema: {
        widgets: {
          id: "text",
        },
      },
    });

    expect(runPluginMigrations).not.toHaveBeenCalled();
  });

  it("rolls back plugin components when schema migration fails", async () => {
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);
    const runPluginMigrations = vi.fn(async () => {
      throw new Error("migration failed");
    });

    runtime.registerDatabaseAdapter({
      isReady: async () => true,
      runPluginMigrations,
    } as never);

    await expect(
      runtime.registerPlugin({
        name: "schema-failure-plugin",
        description: "plugin with a failing database schema",
        schema: {
          widgets: {
            id: "text",
          },
        },
        actions: [
          {
            name: "SCHEMA_FAILURE_ACTION",
            description: "action",
            examples: [],
            similes: [],
            validate: async () => true,
            handler: async () => ({ success: true }),
          },
        ],
        routes: [
          {
            type: "GET",
            path: "/api/schema-failure",
            rawPath: true,
            handler: async (_req, res) => {
              res.json({ ok: true });
            },
          },
        ],
      }),
    ).rejects.toThrow("migration failed");

    expect(
      runtime.plugins.some((p) => p.name === "schema-failure-plugin"),
    ).toBe(false);
    expect(
      runtime.actions.some((a) => a.name === "SCHEMA_FAILURE_ACTION"),
    ).toBe(false);
    expect(hasRoutePath(runtime.routes, "/api/schema-failure")).toBe(false);
  });

  it("shares one failed registration across concurrent same-name callers", async () => {
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);
    const runPluginMigrations = vi.fn(async () => {});
    const initEntered = Promise.withResolvers<void>();
    const initRelease = Promise.withResolvers<void>();

    runtime.registerDatabaseAdapter({
      isReady: async () => true,
      runPluginMigrations,
    } as never);

    const plugin: Plugin = {
      name: "concurrent-failure-plugin",
      description: "plugin whose owner registration fails after publishing",
      schema: {
        widgets: {
          id: "text",
        },
      },
      init: async () => {
        initEntered.resolve();
        await initRelease.promise;
        throw new Error("init failed");
      },
      actions: [
        {
          name: "CONCURRENT_FAILURE_ACTION",
          description: "action",
          examples: [],
          similes: [],
          validate: async () => true,
          handler: async () => ({ success: true }),
        },
      ],
      routes: [
        {
          type: "GET",
          path: "/api/concurrent-failure",
          rawPath: true,
          handler: async (_req, res) => {
            res.json({ ok: true });
          },
        },
      ],
      views: [
        {
          id: "concurrent-failure-view",
          label: "Concurrent failure",
        },
      ],
    };

    const ownerRegistration = runtime.registerPlugin(plugin);
    await initEntered.promise;
    const duplicateRegistration = runtime.registerPlugin(plugin);
    initRelease.resolve();

    const results = await Promise.allSettled([
      ownerRegistration,
      duplicateRegistration,
    ]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(Error);
        expect((result.reason as Error).message).toBe("init failed");
      }
    }
    expect(runPluginMigrations).toHaveBeenCalledOnce();
    expect(runtime.plugins.some((entry) => entry.name === plugin.name)).toBe(
      false,
    );
    expect(
      runtime.actions.some(
        (action) => action.name === "CONCURRENT_FAILURE_ACTION",
      ),
    ).toBe(false);
    expect(hasRoutePath(runtime.routes, "/api/concurrent-failure")).toBe(false);
    expect(getView("concurrent-failure-view")).toBeUndefined();

    await runtime.registerPlugin({
      ...plugin,
      init: async () => {},
    });

    expect(runPluginMigrations).toHaveBeenCalledTimes(2);
    expect(runtime.plugins.some((entry) => entry.name === plugin.name)).toBe(
      true,
    );
    expect(
      runtime.actions.some(
        (action) => action.name === "CONCURRENT_FAILURE_ACTION",
      ),
    ).toBe(true);
    expect(hasRoutePath(runtime.routes, "/api/concurrent-failure")).toBe(true);
    expect(getView("concurrent-failure-view")).toMatchObject({
      pluginName: plugin.name,
    });

    await runtime.unloadPlugin(plugin.name);
    expect(getView("concurrent-failure-view")).toBeUndefined();
  });
});

for (const mode of [
  {
    label: "core lifecycle plus view sync",
    install: installRuntimePluginLifecycle,
  },
  {
    label: "agent fallback lifecycle",
    install: installFallbackLifecycle,
  },
] as const) {
  describe(`${mode.label} operation ordering`, () => {
    it("queues unload behind in-flight init and leaves no resurrected state", async () => {
      const runtime = createTestRuntime() as InspectableRuntime;
      await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
      mode.install(runtime);
      const initEntered = Promise.withResolvers<void>();
      const initRelease = Promise.withResolvers<void>();
      const fixture = makeLifecycleRaceFixture(
        `concurrent-unload-${mode.label.replaceAll(" ", "-")}`,
        "initial",
        async () => {
          initEntered.resolve();
          await initRelease.promise;
        },
      );

      const registration = runtime.registerPlugin(fixture.plugin);
      await initEntered.promise;
      const unload = runtime.unloadPlugin(fixture.plugin.name);
      initRelease.resolve();
      await Promise.all([registration, unload]);

      expectPluginAbsent(runtime, fixture);

      const retry = makeLifecycleRaceFixture(fixture.plugin.name, "retry");
      await runtime.registerPlugin(retry.plugin);
      expectFixturePresent(runtime, retry);
      await runtime.unloadPlugin(retry.plugin.name);
      expectPluginAbsent(runtime, retry);
    });

    it("queues reload behind in-flight init and keeps exactly one replacement", async () => {
      const runtime = createTestRuntime() as InspectableRuntime;
      await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
      mode.install(runtime);
      const initEntered = Promise.withResolvers<void>();
      const initRelease = Promise.withResolvers<void>();
      const pluginName = `concurrent-reload-${mode.label.replaceAll(" ", "-")}`;
      const initial = makeLifecycleRaceFixture(
        pluginName,
        "initial",
        async () => {
          initEntered.resolve();
          await initRelease.promise;
        },
      );
      const replacement = makeLifecycleRaceFixture(pluginName, "replacement");

      const registration = runtime.registerPlugin(initial.plugin);
      await initEntered.promise;
      const reload = runtime.reloadPlugin(replacement.plugin);
      initRelease.resolve();
      await Promise.all([registration, reload]);

      expectFixtureComponentsAbsent(runtime, initial);
      expectFixturePresent(runtime, replacement);

      await runtime.unloadPlugin(pluginName);
      expectPluginAbsent(runtime, replacement);
    });
  });
}

describe("dispose error handling", () => {
  it("a plugin whose dispose hook throws does not corrupt the runtime state", async () => {
    const plugin: Plugin = {
      name: "dispose-error-plugin",
      description: "plugin with a throwing dispose hook",
      dispose: async () => {
        throw new Error("dispose failed intentionally");
      },
      actions: [
        {
          name: "DISPOSE_ERROR_ACTION",
          description: "action",
          examples: [],
          similes: [],
          validate: async () => true,
          handler: async () => ({ success: true }),
        },
      ],
    };

    const runtime = createTestRuntime();
    await runtime.registerPlugin(plugin);
    expect(runtime.actions.some((a) => a.name === "DISPOSE_ERROR_ACTION")).toBe(
      true,
    );

    // unloadPlugin wraps dispose errors in AggregateError and rethrows
    await expect(
      runtime.unloadPlugin("dispose-error-plugin"),
    ).rejects.toThrow();

    // Despite the error, the lifecycle still removes the plugin's components
    // because teardownPluginOwnership runs component removal in a separate
    // try/catch from the dispose hook.
    // The action should be removed even when dispose threw.
    expect(runtime.actions.some((a) => a.name === "DISPOSE_ERROR_ACTION")).toBe(
      false,
    );
  });
});

describe("service-class snapshot with a service-less plugin (#16928)", () => {
  // The nullish-array ratchet fix replaced `plugin.services ?? []` iteration
  // in snapshotPluginServiceClasses/trackPluginServiceClasses with early
  // returns. A plugin without a `services` array must still register and
  // unload cleanly through the serialized lifecycle (the tracking pass is a
  // no-op for it) and must not disturb another plugin's service ownership.
  it("registers and unloads a service-less plugin without touching service state", async () => {
    const runtime = createTestRuntime() as InspectableRuntime;
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    installRuntimePluginLifecycle(runtime);
    const withService = makeLifecycleRaceFixture("ratchet-guard-plugin", "v1");
    const serviceLess = makeSyntheticSkillsPlugin();

    await runtime.registerPlugin(withService.plugin);
    expect(runtime.hasService(withService.serviceType)).toBe(true);

    await runtime.registerPlugin(serviceLess);
    expect(serviceLess.services).toBeUndefined();
    expect(runtime.actions.some((a) => a.name === "USE_SKILL")).toBe(true);
    // The service-less registration must not have perturbed the other
    // plugin's service registration.
    expect(runtime.hasService(withService.serviceType)).toBe(true);

    await runtime.unloadPlugin(serviceLess.name);
    expect(runtime.actions.some((a) => a.name === "USE_SKILL")).toBe(false);
    expect(runtime.hasService(withService.serviceType)).toBe(true);

    await runtime.unloadPlugin(withService.plugin.name);
    expect(runtime.hasService(withService.serviceType)).toBe(false);
  });
});
