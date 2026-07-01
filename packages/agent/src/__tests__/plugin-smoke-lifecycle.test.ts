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

import type { Plugin } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { installRuntimePluginLifecycle } from "../runtime/plugin-lifecycle.ts";
import { createTestRuntime } from "./plugin-lifecycle-test-utils.ts";

/** Returns true if the runtime has a registered route whose path includes the given segment. */
function hasRoutePath(routes: { path: string }[], segment: string): boolean {
  return routes.some((r) => r.path.includes(segment));
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
  it("runs plugin migrations after a schema plugin registers against a ready adapter", async () => {
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);
    const runPluginMigrations = vi.fn(async () => {});

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
});

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
