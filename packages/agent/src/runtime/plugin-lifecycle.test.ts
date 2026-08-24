/**
 * Unit coverage for installRuntimePluginLifecycle / supportsRuntimePluginLifecycle
 * against an in-memory runtime double whose registerPlugin mirrors core's
 * declarative registration loop: plugin-to-component ownership attribution,
 * duplicate-action skipping, context inheritance, joined concurrent
 * registrations, applyPluginConfig routing, teardown on unload, and
 * fail-closed rollback of a failed registration.
 */
import type {
  Action,
  AgentContext,
  AgentRuntime,
  IDatabaseAdapter,
  Plugin,
  PluginEvents,
  Provider,
  RegisteredEvaluator,
  Route,
  ServiceClass,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimePluginLifecycle,
  supportsRuntimePluginLifecycle,
} from "./plugin-lifecycle.ts";

type HandlerFn = (...args: unknown[]) => unknown;

interface ServiceClassDouble {
  serviceType: string;
  new (): { stop: () => Promise<void> };
}

interface RuntimeDouble {
  agentId: string;
  logger: Record<"debug" | "info" | "warn" | "error", HandlerFn>;
  character: { settings: { tools: { cache: { enabled: false } } } };
  actions: Action[];
  providers: Provider[];
  evaluators: RegisteredEvaluator[];
  routes: Route[];
  plugins: Plugin[];
  events: Record<string, HandlerFn[]>;
  services: Map<string, Array<{ stop: () => Promise<void> }>>;
  adapter?: IDatabaseAdapter;
  models: Map<string, Array<{ handler: unknown; provider?: string }>>;
  serviceTypes: Map<string, ServiceClassDouble[]>;
  startingServices: Map<string, Promise<unknown>>;
  servicePromises: Map<string, Promise<unknown>>;
  servicePromiseHandlers: Map<string, unknown>;
  serviceRegistrationStatus: Map<string, string>;
  sendHandlers: Map<string, HandlerFn>;
  throwOnActionName?: string;
  serviceStops: string[];
  registerPlugin: (plugin: Plugin) => Promise<void>;
  registerAction: (action: Action) => void;
  registerProvider: (provider: Provider) => void;
  registerEvaluator: (evaluator: RegisteredEvaluator) => void;
  registerModel: (
    modelType: string,
    handler: unknown,
    provider?: string,
  ) => void;
  registerEvent: (event: string, handler: unknown) => void;
  registerService: (serviceClass: ServiceClassDouble) => Promise<void>;
  registerDatabaseAdapter: (adapter: IDatabaseAdapter) => void;
  unloadPlugin?: (pluginName: string) => Promise<unknown>;
  reloadPlugin?: (plugin: Plugin) => Promise<void>;
  applyPluginConfig?: (
    pluginName: string,
    config: Record<string, string>,
  ) => Promise<boolean>;
  getPluginOwnership?: (pluginName: string) => unknown;
  getAllPluginOwnership?: () => unknown[];
}

function makeRuntimeDouble(): RuntimeDouble {
  const runtime: RuntimeDouble = {
    agentId: "test-agent",
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    character: { settings: { tools: { cache: { enabled: false } } } },
    actions: [],
    providers: [],
    evaluators: [],
    routes: [],
    plugins: [],
    events: {},
    services: new Map(),
    models: new Map(),
    serviceTypes: new Map(),
    startingServices: new Map(),
    servicePromises: new Map(),
    servicePromiseHandlers: new Map(),
    serviceRegistrationStatus: new Map(),
    sendHandlers: new Map(),
    serviceStops: [],
    registerPlugin: null as unknown as RuntimeDouble["registerPlugin"],
    registerAction: null as unknown as RuntimeDouble["registerAction"],
    registerProvider: null as unknown as RuntimeDouble["registerProvider"],
    registerEvaluator: null as unknown as RuntimeDouble["registerEvaluator"],
    registerModel: null as unknown as RuntimeDouble["registerModel"],
    registerEvent: null as unknown as RuntimeDouble["registerEvent"],
    registerService: null as unknown as RuntimeDouble["registerService"],
    registerDatabaseAdapter:
      null as unknown as RuntimeDouble["registerDatabaseAdapter"],
  };

  // Mirrors AgentRuntime.registerPlugin's declarative loop: init first, then
  // every component family through the (wrapped) register methods, so the
  // lifecycle under test observes registrations exactly like production.
  runtime.registerPlugin = async (plugin: Plugin) => {
    runtime.plugins.push(plugin);
    await plugin.init?.({}, runtime as unknown as AgentRuntime);
    for (const action of plugin.actions ?? []) runtime.registerAction(action);
    for (const provider of plugin.providers ?? []) {
      runtime.registerProvider(provider);
    }
    for (const evaluator of plugin.evaluators ?? []) {
      runtime.registerEvaluator(evaluator);
    }
    for (const [modelType, handler] of Object.entries(plugin.models ?? {})) {
      runtime.registerModel(modelType, handler);
    }
    for (const route of plugin.routes ?? []) runtime.routes.push(route);
    for (const [eventName, handlers] of Object.entries(plugin.events ?? {})) {
      for (const handler of handlers ?? []) {
        runtime.registerEvent(eventName, handler);
      }
    }
    for (const service of plugin.services ?? []) {
      await runtime.registerService(service as unknown as ServiceClassDouble);
    }
    const adapterFactory = plugin.adapter;
    if (adapterFactory) {
      const adapter = await Promise.resolve(
        adapterFactory(runtime.agentId, {} as never),
      );
      runtime.registerDatabaseAdapter(adapter as unknown as IDatabaseAdapter);
    }
  };
  runtime.registerAction = (action: Action) => {
    if (action.name === runtime.throwOnActionName) {
      throw new Error(`forced registration failure for ${action.name}`);
    }
    if (!runtime.actions.includes(action)) runtime.actions.push(action);
  };
  runtime.registerProvider = (provider: Provider) => {
    if (!runtime.providers.includes(provider)) runtime.providers.push(provider);
  };
  runtime.registerEvaluator = (evaluator: RegisteredEvaluator) => {
    if (!runtime.evaluators.includes(evaluator))
      runtime.evaluators.push(evaluator);
  };
  runtime.registerModel = (modelType: string, handler: unknown, provider?) => {
    const list = runtime.models.get(modelType) ?? [];
    list.push({ handler, provider });
    runtime.models.set(modelType, list);
  };
  runtime.registerEvent = (event: string, handler: unknown) => {
    const list = runtime.events[event] ?? [];
    list.push(handler as HandlerFn);
    runtime.events[event] = list;
  };
  runtime.registerService = async (serviceClass: ServiceClassDouble) => {
    const classes = runtime.serviceTypes.get(serviceClass.serviceType) ?? [];
    classes.push(serviceClass);
    runtime.serviceTypes.set(serviceClass.serviceType, classes);
    const instances = runtime.services.get(serviceClass.serviceType) ?? [];
    instances.push({
      stop: async () => {
        runtime.serviceStops.push(serviceClass.serviceType);
      },
    });
    runtime.services.set(serviceClass.serviceType, instances);
  };
  runtime.registerDatabaseAdapter = (adapter: IDatabaseAdapter) => {
    runtime.adapter = adapter;
  };

  return runtime;
}

function asAgentRuntime(double: RuntimeDouble): AgentRuntime {
  return double as unknown as AgentRuntime;
}

function makeAction(name: string): Action {
  return {
    name,
    description: `${name} action`,
    handler: async () => ({ success: true, text: name }),
    validate: async () => true,
  };
}

function makeProvider(name: string): Provider {
  return {
    name,
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

function makePlugin(name: string, extra?: Partial<Plugin>): Plugin {
  return { name, description: `${name} plugin`, ...extra };
}

const noopHandler = (() => {}) as HandlerFn;

describe("installRuntimePluginLifecycle", () => {
  it("leaves a runtime without the required register methods untouched", () => {
    const partial = {
      agentId: "partial-agent",
      actions: [],
      providers: [],
      evaluators: [],
      routes: [],
      plugins: [],
      events: {},
      services: new Map(),
      logger: { debug: () => {}, warn: () => {}, error: () => {} },
    } as unknown as AgentRuntime;

    installRuntimePluginLifecycle(partial);

    expect(supportsRuntimePluginLifecycle(partial)).toBe(false);
  });

  it("attributes every registered component to the owning plugin", async () => {
    const runtime = makeRuntimeDouble();
    installRuntimePluginLifecycle(asAgentRuntime(runtime));
    expect(supportsRuntimePluginLifecycle(asAgentRuntime(runtime))).toBe(true);

    const action = makeAction("ALPHA_ACTION");
    const provider = makeProvider("ALPHA_PROVIDER");
    const evaluator = makeEvaluator("ALPHA_EVALUATOR");
    const modelHandler = async () => "alpha-model";
    class AlphaService {
      static serviceType = "alpha_service";
      async stop() {}
    }
    const route = { type: "GET", path: "/alpha" } as unknown as Route;

    await runtime.registerPlugin(
      makePlugin("alpha", {
        actions: [action],
        providers: [provider],
        evaluators: [evaluator],
        models: { TEXT_SMALL: modelHandler },
        events: { alpha_event: [noopHandler] } as unknown as PluginEvents,
        services: [AlphaService as unknown as ServiceClass],
        routes: [route],
      }),
    );

    const ownership = runtime.getPluginOwnership?.("alpha") as {
      pluginName: string;
      actions: Action[];
      providers: Provider[];
      evaluators: RegisteredEvaluator[];
      models: Array<{ modelType: string; handler: unknown; provider?: string }>;
      events: Array<{ eventName: string; handler: unknown }>;
      services: Array<{ serviceType: string }>;
      routes: Route[];
      hasAdapter: boolean;
    };
    expect(ownership.pluginName).toBe("alpha");
    expect(ownership.actions).toHaveLength(1);
    expect(ownership.actions[0].name).toBe("ALPHA_ACTION");
    expect(
      (ownership.actions[0] as Action & { contexts?: string[] }).contexts,
    ).toEqual(["general"]);
    expect(ownership.providers).toHaveLength(1);
    expect(ownership.providers[0].name).toBe("ALPHA_PROVIDER");
    expect(
      (ownership.providers[0] as Provider & { contexts?: string[] }).contexts,
    ).toEqual(["general"]);
    expect(ownership.evaluators).toEqual([evaluator]);
    expect(ownership.models).toHaveLength(1);
    expect(ownership.models[0].modelType).toBe("TEXT_SMALL");
    expect(ownership.models[0].handler).toBe(modelHandler);
    expect(ownership.events).toEqual([
      { eventName: "alpha_event", handler: noopHandler },
    ]);
    expect(ownership.services.map((s) => s.serviceType)).toEqual([
      "alpha_service",
    ]);
    expect(ownership.routes).toEqual([route]);
    expect(ownership.hasAdapter).toBe(false);

    const all = runtime.getAllPluginOwnership?.() as Array<{
      pluginName: string;
    }>;
    expect(all.map((o) => o.pluginName)).toContain("alpha");
  });

  it("skips a duplicate action name before runtime registration", async () => {
    const runtime = makeRuntimeDouble();
    installRuntimePluginLifecycle(asAgentRuntime(runtime));

    await runtime.registerPlugin(
      makePlugin("dup", {
        actions: [makeAction("DUP"), makeAction("DUP")],
      }),
    );

    expect(runtime.actions.filter((a) => a.name === "DUP")).toHaveLength(1);
  });

  it("inherits plugin contexts onto context-less components and keeps explicit ones", async () => {
    const runtime = makeRuntimeDouble();
    installRuntimePluginLifecycle(asAgentRuntime(runtime));

    await runtime.registerPlugin(
      makePlugin("contextual", {
        contexts: [
          "plugin-context-a",
          "plugin-context-b",
        ] as unknown as AgentContext[],
        actions: [makeAction("INHERITS"), makeAction("EXPLICIT")],
        providers: [makeProvider("PROVIDER_KEEP")],
      }),
    );

    const explicit = runtime.actions[1] as Action & {
      contexts?: string[];
    };
    explicit.contexts = ["own-context"];

    await runtime.registerPlugin(
      makePlugin("contextual-second", {
        contexts: ["ctx-a", "ctx-b"] as unknown as AgentContext[],
        actions: [makeAction("INHERITS_2"), explicit],
      }),
    );

    const inherited = runtime.actions.find((a) => a.name === "INHERITS_2");
    expect(inherited?.contexts).toEqual(["ctx-a", "ctx-b"]);
    expect(explicit.contexts).toEqual(["own-context"]);
  });

  it("joins concurrent registrations of the same plugin into one run", async () => {
    const runtime = makeRuntimeDouble();
    let baseRuns = 0;
    const rawRegisterPlugin = runtime.registerPlugin.bind(runtime);
    runtime.registerPlugin = async (plugin: Plugin) => {
      baseRuns += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await rawRegisterPlugin(plugin);
    };
    installRuntimePluginLifecycle(asAgentRuntime(runtime));

    const plugin = makePlugin("joiner", {
      actions: [makeAction("JOINER_ACTION")],
    });

    const first = runtime.registerPlugin(plugin);
    const second = runtime.registerPlugin(plugin);
    await Promise.all([first, second]);

    expect(baseRuns).toBe(1);
    expect(runtime.plugins.filter((p) => p.name === "joiner")).toHaveLength(1);
    expect(runtime.getPluginOwnership?.("joiner")).not.toBeNull();
  });

  it("tracks a plugin reference even when the plugin registers nothing", async () => {
    const runtime = makeRuntimeDouble();
    installRuntimePluginLifecycle(asAgentRuntime(runtime));

    const ghost = makePlugin("ghost");
    await runtime.registerPlugin(ghost);

    expect(runtime.plugins).toContain(ghost);
    const ownership = runtime.getPluginOwnership?.("ghost") as {
      pluginName: string;
      registeredPlugin: Plugin | null;
      actions: unknown[];
      providers: unknown[];
      evaluators: unknown[];
      routes: unknown[];
      events: unknown[];
      models: unknown[];
      services: unknown[];
      hasAdapter: boolean;
    };
    expect(ownership.pluginName).toBe("ghost");
    expect(ownership.registeredPlugin).toBe(ghost);
    expect(ownership.actions).toEqual([]);
    expect(ownership.providers).toEqual([]);
    expect(ownership.evaluators).toEqual([]);
    expect(ownership.routes).toEqual([]);
    expect(ownership.events).toEqual([]);
    expect(ownership.models).toEqual([]);
    expect(ownership.services).toEqual([]);
    expect(ownership.hasAdapter).toBe(false);
  });

  describe("unloadPlugin", () => {
    it("stops owned services, removes owned components, and drops ownership", async () => {
      const runtime = makeRuntimeDouble();
      installRuntimePluginLifecycle(asAgentRuntime(runtime));

      class TempService {
        static serviceType = "temp_service";
        async stop() {}
      }

      await runtime.registerPlugin(
        makePlugin("removable", {
          actions: [makeAction("REMOVE_ME")],
          providers: [makeProvider("REMOVE_PROVIDER")],
          evaluators: [makeEvaluator("REMOVE_EVALUATOR")],
          models: { TEXT_SMALL: async () => "bye" },
          events: { remove_event: [noopHandler] } as unknown as PluginEvents,
          services: [TempService as unknown as ServiceClass],
          routes: [{ type: "GET", path: "/removable" } as unknown as Route],
        }),
      );
      expect(runtime.getPluginOwnership?.("removable")).not.toBeNull();

      const ownership = (await runtime.unloadPlugin?.("removable")) as {
        pluginName: string;
      };

      expect(ownership.pluginName).toBe("removable");
      expect(runtime.actions).toHaveLength(0);
      expect(runtime.providers).toHaveLength(0);
      expect(runtime.evaluators).toHaveLength(0);
      expect(runtime.routes).toHaveLength(0);
      expect(runtime.events.remove_event).toBeUndefined();
      expect(runtime.models.has("TEXT_SMALL")).toBe(false);
      expect(runtime.serviceTypes.has("temp_service")).toBe(false);
      expect(runtime.services.has("temp_service")).toBe(false);
      expect(runtime.serviceStops).toEqual(["temp_service"]);
      expect(runtime.getPluginOwnership?.("removable")).toBeNull();

      expect(await runtime.unloadPlugin?.("never-registered")).toBeNull();
    });

    it("refuses to unload a plugin that owns the database adapter", async () => {
      const runtime = makeRuntimeDouble();
      installRuntimePluginLifecycle(asAgentRuntime(runtime));

      const adapter = { ready: true } as unknown as IDatabaseAdapter;
      await runtime.registerPlugin(
        makePlugin("adapter-owner", {
          adapter: () => adapter,
        }),
      );

      const ownership = runtime.getPluginOwnership?.("adapter-owner") as {
        hasAdapter: boolean;
      };
      expect(ownership.hasAdapter).toBe(true);
      expect(runtime.adapter).toBe(adapter);

      await expect(runtime.unloadPlugin?.("adapter-owner")).rejects.toThrow(
        /requires a runtime reload/,
      );
      expect(runtime.getPluginOwnership?.("adapter-owner")).not.toBeNull();
    });
  });

  describe("failed registration", () => {
    it("rolls back already attributed components and rethrows", async () => {
      const runtime = makeRuntimeDouble();
      runtime.throwOnActionName = "POISON_ACTION";
      installRuntimePluginLifecycle(asAgentRuntime(runtime));

      const failing = makePlugin("boomer", {
        actions: [makeAction("GOOD_ACTION"), makeAction("POISON_ACTION")],
      });

      await expect(runtime.registerPlugin(failing)).rejects.toThrow(
        "forced registration failure for POISON_ACTION",
      );

      expect(runtime.actions).toHaveLength(0);
      expect(runtime.plugins).not.toContain(failing);
      expect(runtime.getPluginOwnership?.("boomer")).toBeNull();
    });
  });

  describe("applyPluginConfig", () => {
    it("routes config to the owning plugin's applyConfig hook", async () => {
      const runtime = makeRuntimeDouble();
      installRuntimePluginLifecycle(asAgentRuntime(runtime));

      const applyConfig = vi.fn(async () => {});
      await runtime.registerPlugin(makePlugin("configurable", { applyConfig }));

      const delivered = await runtime.applyPluginConfig?.("configurable", {
        KEY: "value",
      });
      expect(delivered).toBe(true);
      expect(applyConfig).toHaveBeenCalledWith(
        { KEY: "value" },
        expect.anything(),
      );
    });

    it("returns false for unknown plugins and hookless plugins", async () => {
      const runtime = makeRuntimeDouble();
      installRuntimePluginLifecycle(asAgentRuntime(runtime));

      expect(await runtime.applyPluginConfig?.("missing", {})).toBe(false);

      await runtime.registerPlugin(makePlugin("hookless"));
      expect(await runtime.applyPluginConfig?.("hookless", {})).toBe(false);
    });
  });

  it("tolerates a repeated install without throwing", () => {
    const runtime = makeRuntimeDouble();
    const asRuntime = asAgentRuntime(runtime);

    expect(() => {
      installRuntimePluginLifecycle(asRuntime);
      installRuntimePluginLifecycle(asRuntime);
    }).not.toThrow();
    expect(supportsRuntimePluginLifecycle(asRuntime)).toBe(true);
  });
});

describe("supportsRuntimePluginLifecycle", () => {
  it("returns false for null and bare objects", () => {
    expect(supportsRuntimePluginLifecycle(null)).toBe(false);
    expect(supportsRuntimePluginLifecycle({} as AgentRuntime)).toBe(false);
  });

  it("returns true for a runtime with the lifecycle installed", () => {
    const runtime = makeRuntimeDouble();
    installRuntimePluginLifecycle(asAgentRuntime(runtime));
    expect(supportsRuntimePluginLifecycle(asAgentRuntime(runtime))).toBe(true);
  });
});
