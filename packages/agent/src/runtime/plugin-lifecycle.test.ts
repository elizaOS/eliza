/**
 * Agent plugin-lifecycle contract tests exercise the real `AgentRuntime`
 * registration loop and the lifecycle installed by core, with the agent view
 * synchronization layer applied on top. No test double reimplements plugin
 * registration, ownership capture, rollback, or teardown.
 */

import type {
  Action,
  AgentRuntime,
  IAgentRuntime,
  IDatabaseAdapter,
  Plugin,
  PluginEvents,
  Provider,
  RegisteredEvaluator,
  Route,
} from "@elizaos/core";
import { Service } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "../__tests__/plugin-lifecycle-test-utils.ts";
import {
  installRuntimePluginLifecycle,
  supportsRuntimePluginLifecycle,
} from "./plugin-lifecycle.ts";

function makeAction(name: string): Action {
  return {
    name,
    description: `${name} action`,
    examples: [],
    similes: [],
    handler: async () => ({ success: true, text: name }),
    validate: async () => true,
  };
}

function makeProvider(name: string): Provider {
  return {
    name,
    description: `${name} provider`,
    get: async () => ({ text: `${name} provider output` }),
  };
}

function makeEvaluator(name: string): RegisteredEvaluator {
  return {
    name,
    description: `${name} evaluator`,
    schema: { type: "object" },
    shouldRun: async () => true,
    prompt: () => `${name} prompt`,
  };
}

function makeRoute(path: string): Route {
  return {
    type: "GET",
    path,
    rawPath: true,
    handler: async (_request, response) => {
      response.json({ ok: true });
    },
  };
}

function makePlugin(name: string, extra: Partial<Plugin> = {}): Plugin {
  return { name, description: `${name} plugin`, ...extra };
}

describe("installRuntimePluginLifecycle with AgentRuntime", () => {
  it("leaves an incomplete runtime unsupported", () => {
    const partial = {} as AgentRuntime;

    installRuntimePluginLifecycle(partial);

    expect(supportsRuntimePluginLifecycle(partial)).toBe(false);
  });

  it("keeps repeated agent-layer installation idempotent", () => {
    const runtime = createTestRuntime();
    expect(supportsRuntimePluginLifecycle(runtime)).toBe(true);

    installRuntimePluginLifecycle(runtime);
    const installedRegisterPlugin = runtime.registerPlugin;
    const installedUnloadPlugin = runtime.unloadPlugin;

    installRuntimePluginLifecycle(runtime);

    expect(runtime.registerPlugin).toBe(installedRegisterPlugin);
    expect(runtime.unloadPlugin).toBe(installedUnloadPlugin);
    expect(supportsRuntimePluginLifecycle(runtime)).toBe(true);
  });

  it("captures real component registration and tears down the owned service", async () => {
    const runtime = createTestRuntime();
    await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
    installRuntimePluginLifecycle(runtime);
    const serviceStop = vi.fn(async () => {});
    const eventHandler = vi.fn(async () => {});
    const modelHandler = vi.fn(async () => "alpha model output");

    class AlphaService extends Service {
      static override serviceType = "alpha_lifecycle_service";
      override capabilityDescription = "Alpha lifecycle test service";

      static override async start(
        serviceRuntime: IAgentRuntime,
      ): Promise<AlphaService> {
        return new AlphaService(serviceRuntime);
      }

      override async stop(): Promise<void> {
        await serviceStop();
      }
    }

    const route = makeRoute("/alpha-lifecycle");
    const plugin = makePlugin("alpha-lifecycle", {
      contexts: ["alpha-context"],
      actions: [
        makeAction("ALPHA_LIFECYCLE_ACTION"),
        makeAction("ALPHA_LIFECYCLE_ACTION"),
      ],
      providers: [makeProvider("ALPHA_LIFECYCLE_PROVIDER")],
      evaluators: [makeEvaluator("ALPHA_LIFECYCLE_EVALUATOR")],
      models: { TEXT_SMALL: modelHandler },
      events: {
        alpha_lifecycle_event: [eventHandler],
      } as unknown as PluginEvents,
      services: [AlphaService],
      routes: [route],
    });

    const baseline = {
      actions: runtime.actions.length,
      providers: runtime.providers.length,
      evaluators: runtime.evaluators.length,
      routes: runtime.routes.length,
    };

    await runtime.registerPlugin(plugin);
    await runtime.getServiceLoadPromise(AlphaService.serviceType);

    const ownership = runtime.getPluginOwnership(plugin.name);
    expect(ownership).not.toBeNull();
    expect(ownership?.registeredPlugin).toBe(plugin);
    expect(ownership?.actions.map((action) => action.name)).toEqual([
      "ALPHA_LIFECYCLE_ACTION",
    ]);
    expect(ownership?.actions[0].contexts).toEqual(["alpha-context"]);
    expect(ownership?.providers.map((provider) => provider.name)).toEqual([
      "ALPHA_LIFECYCLE_PROVIDER",
    ]);
    expect(ownership?.providers[0].contexts).toEqual(["alpha-context"]);
    expect(ownership?.evaluators.map((evaluator) => evaluator.name)).toEqual([
      "ALPHA_LIFECYCLE_EVALUATOR",
    ]);
    expect(ownership?.models).toEqual([
      expect.objectContaining({
        modelType: "TEXT_SMALL",
        handler: modelHandler,
        provider: plugin.name,
      }),
    ]);
    expect(ownership?.events).toEqual([
      { eventName: "alpha_lifecycle_event", handler: eventHandler },
    ]);
    expect(ownership?.services.map(({ serviceType }) => serviceType)).toEqual([
      AlphaService.serviceType,
    ]);
    expect(ownership?.routes).toEqual([route]);
    expect(runtime.hasService(AlphaService.serviceType)).toBe(true);

    await runtime.unloadPlugin(plugin.name);

    expect(serviceStop).toHaveBeenCalledOnce();
    expect(runtime.actions).toHaveLength(baseline.actions);
    expect(runtime.providers).toHaveLength(baseline.providers);
    expect(runtime.evaluators).toHaveLength(baseline.evaluators);
    expect(runtime.routes).toHaveLength(baseline.routes);
    expect(runtime.events.alpha_lifecycle_event).toBeUndefined();
    expect(runtime.hasService(AlphaService.serviceType)).toBe(false);
    expect(runtime.getPluginOwnership(plugin.name)).toBeNull();
  });

  it("joins concurrent registration callers into one real initialization", async () => {
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);
    const initEntered = Promise.withResolvers<void>();
    const initRelease = Promise.withResolvers<void>();
    const init = vi.fn(async () => {
      initEntered.resolve();
      await initRelease.promise;
    });
    const plugin = makePlugin("joined-lifecycle", {
      init,
      actions: [makeAction("JOINED_LIFECYCLE_ACTION")],
    });

    const first = runtime.registerPlugin(plugin);
    await initEntered.promise;
    const second = runtime.registerPlugin(plugin);
    initRelease.resolve();
    await Promise.all([first, second]);

    expect(init).toHaveBeenCalledOnce();
    expect(
      runtime.plugins.filter((candidate) => candidate.name === plugin.name),
    ).toEqual([plugin]);
    expect(
      runtime.actions.filter(
        (action) => action.name === "JOINED_LIFECYCLE_ACTION",
      ),
    ).toHaveLength(1);
    expect(runtime.getPluginOwnership(plugin.name)).not.toBeNull();
  });

  it("rolls back components published before a late adapter failure", async () => {
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);
    const eventHandler = vi.fn(async () => {});
    const route = makeRoute("/rollback-lifecycle");
    const plugin = makePlugin("rollback-lifecycle", {
      actions: [makeAction("ROLLBACK_LIFECYCLE_ACTION")],
      providers: [makeProvider("ROLLBACK_LIFECYCLE_PROVIDER")],
      routes: [route],
      events: {
        rollback_lifecycle_event: [eventHandler],
      } as unknown as PluginEvents,
      adapter: async () => {
        throw new Error("adapter construction failed");
      },
    });

    await expect(runtime.registerPlugin(plugin)).rejects.toThrow(
      "adapter construction failed",
    );

    expect(runtime.plugins).not.toContain(plugin);
    expect(
      runtime.actions.some(
        (action) => action.name === "ROLLBACK_LIFECYCLE_ACTION",
      ),
    ).toBe(false);
    expect(
      runtime.providers.some(
        (provider) => provider.name === "ROLLBACK_LIFECYCLE_PROVIDER",
      ),
    ).toBe(false);
    expect(runtime.routes).not.toContain(route);
    expect(runtime.events.rollback_lifecycle_event).toBeUndefined();
    expect(runtime.getPluginOwnership(plugin.name)).toBeNull();
  });

  it("refuses to hot-unload the real runtime's adapter owner", async () => {
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);
    const adapter = { isReady: async () => true } as IDatabaseAdapter;
    const plugin = makePlugin("adapter-lifecycle", {
      adapter: () => adapter,
    });

    await runtime.registerPlugin(plugin);

    expect(runtime.adapter).toBe(adapter);
    expect(runtime.getPluginOwnership(plugin.name)?.hasAdapter).toBe(true);
    await expect(runtime.unloadPlugin(plugin.name)).rejects.toThrow(
      /requires a runtime reload/,
    );
    expect(runtime.plugins).toContain(plugin);
    expect(runtime.getPluginOwnership(plugin.name)).not.toBeNull();
  });

  it("routes configuration only to the registered plugin hook", async () => {
    const runtime = createTestRuntime();
    installRuntimePluginLifecycle(runtime);
    const applyConfig = vi.fn(async () => {});
    const configurable = makePlugin("configurable-lifecycle", {
      applyConfig,
    });

    expect(await runtime.applyPluginConfig("missing-lifecycle", {})).toBe(
      false,
    );
    await runtime.registerPlugin(configurable);
    await expect(
      runtime.applyPluginConfig(configurable.name, { KEY: "value" }),
    ).resolves.toBe(true);
    expect(applyConfig).toHaveBeenCalledWith({ KEY: "value" }, runtime);

    const hookless = makePlugin("hookless-lifecycle");
    await runtime.registerPlugin(hookless);
    await expect(runtime.applyPluginConfig(hookless.name, {})).resolves.toBe(
      false,
    );
  });
});

describe("supportsRuntimePluginLifecycle", () => {
  it("distinguishes absent lifecycle support from a real runtime", () => {
    expect(supportsRuntimePluginLifecycle(null)).toBe(false);
    expect(supportsRuntimePluginLifecycle({} as AgentRuntime)).toBe(false);
    expect(supportsRuntimePluginLifecycle(createTestRuntime())).toBe(true);
  });
});
