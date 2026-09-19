/**
 * Tests declared production-plugin resolution and pre-initialization runtime
 * registration and the explicit package-versus-seed-fixture declaration.
 * Real package imports against a fake runtime.
 */

import {
  type AgentRuntime,
  ElizaError,
  getTurnActionConstraint,
  type Plugin,
  type ResponseHandlerEvaluatorContext,
  ResponseHandlerFieldRegistry,
  runWithStreamingContext,
  stringToUuid,
} from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  assertScenarioPluginPackageSpecifier,
  assertSharedRuntimePluginBatchSafe,
  loadScenarioRequiredPlugin,
  registerScenarioRequiredPlugins,
  resolveRequiredFixturePlugins,
  resolveRequiredPluginPackages,
} from "./required-plugins.ts";

describe("scenario required plugin registration", () => {
  it("binds a simulated app-control navigation prohibition through the real Stage1 field handler", async () => {
    const plugin = await loadScenarioRequiredPlugin(
      "@elizaos/plugin-app-control",
      "simulated",
    );
    if (!plugin) throw new Error("App-control plugin did not load");
    const runtime = createMockRuntime({ actions: plugin.actions });
    const messageId = stringToUuid("navigation-field-turn");
    const ctx: ResponseHandlerEvaluatorContext = {
      runtime,
      message: {
        id: messageId,
        roomId: stringToUuid("navigation-field-room"),
        entityId: stringToUuid("navigation-field-user"),
        agentId: runtime.agentId,
        content: {
          text: "Search views without navigating",
          source: "client_chat",
          channelType: "DM",
        },
      },
      state: { values: {}, data: {}, text: "" },
      messageHandler: {
        processMessage: "RESPOND",
        thought: "Search the catalog without navigation.",
        plan: {
          contexts: ["settings"],
          candidateActions: ["VIEWS"],
          reply: "Searching views.",
        },
      },
      availableContexts: [],
      userRoles: ["USER"],
    };
    const registry = new ResponseHandlerFieldRegistry();
    for (const field of plugin.responseHandlerFieldEvaluators ?? [])
      registry.register(field);
    const reason = "The user explicitly requires staying on the current view.";
    await runWithStreamingContext({ messageId }, async () => {
      const dispatched = await registry.dispatch({
        runtime,
        message: ctx.message,
        state: ctx.state,
        senderRole: "USER",
        turnSignal: new AbortController().signal,
        rawParsed: {
          visualContinuation: {
            disposition: "forbidden",
            viewId: "",
            singleViewOnly: false,
            navigationOnly: false,
            reason,
          },
        },
      });
      expect(dispatched.fieldErrors).toEqual({});
      // Require a real field dispatch before evaluating, avoiding network fallback
      // when the loader drops the handler that binds this decision.
      expect(dispatched.traces.length).toBeGreaterThan(0);
      for (const evaluator of plugin.responseHandlerEvaluators ?? []) {
        if (await evaluator.shouldRun(ctx)) await evaluator.evaluate(ctx);
      }
      expect(
        getTurnActionConstraint(
          {
            messageId,
            roomId: ctx.message.roomId,
            actorId: ctx.message.entityId,
            action: "VIEWS",
          },
          "show",
        ),
      ).toMatchObject({ disposition: "deny", reason });
    });
  });

  it("loads and registers Maps for a simulated live-model runtime", async () => {
    const plugins: Plugin[] = [];
    const registerPlugin = vi.fn(async (plugin: Plugin) => {
      plugins.push(plugin);
    });
    const runtime = { plugins, registerPlugin } as unknown as Pick<
      AgentRuntime,
      "plugins" | "registerPlugin"
    >;

    await expect(
      registerScenarioRequiredPlugins(
        runtime,
        ["@elizaos/plugin-maps"],
        "simulated",
      ),
    ).resolves.toEqual(["@elizaos/plugin-maps"]);
    expect(registerPlugin).toHaveBeenCalledOnce();
    expect(plugins.map((plugin) => plugin.name)).toEqual(["maps"]);
    expect(plugins[0]?.actions?.map((action) => action.name)).toContain(
      "MAPS_SAVE",
    );
  });

  it("keeps package import specifiers separate from seed fixture names", async () => {
    const scenario = {
      id: "fixture-plugin",
      title: "fixture plugin",
      domain: "other",
      turns: [],
      requires: {
        plugins: [
          "unscoped-plugin",
          "@elizaos/plugin-maps",
          "@elizaos/plugin-meetings/test-support",
          "unscoped-plugin/test-support",
        ],
        fixturePlugins: ["echo-test", "orchestrator-watchdog-scenario"],
      },
    } as const;
    const plugins: Plugin[] = [];
    const registerPlugin = vi.fn(async (plugin: Plugin) => {
      plugins.push(plugin);
    });
    const runtime = { plugins, registerPlugin } as unknown as Pick<
      AgentRuntime,
      "plugins" | "registerPlugin"
    >;

    expect(resolveRequiredPluginPackages(scenario)).toEqual([
      "unscoped-plugin",
      "@elizaos/plugin-maps",
      "@elizaos/plugin-meetings/test-support",
      "unscoped-plugin/test-support",
    ]);
    expect(resolveRequiredFixturePlugins(scenario)).toEqual([
      "echo-test",
      "orchestrator-watchdog-scenario",
    ]);
    await expect(
      registerScenarioRequiredPlugins(
        runtime,
        ["@elizaos/plugin-maps"],
        "simulated",
      ),
    ).resolves.toEqual(["@elizaos/plugin-maps"]);
    expect(registerPlugin).toHaveBeenCalledOnce();
    expect(plugins.map((plugin) => plugin.name)).toEqual(["maps"]);
  });

  it.each([
    "./scenario-plugin.ts",
    "../scenario-plugin.ts",
    "/tmp/scenario-plugin.mjs",
    "file:///tmp/scenario-plugin.mjs",
    "workspace:@example/scenario-plugin",
  ])("typed-rejects unsupported package specifier %s", (packageName) => {
    expect(() => assertScenarioPluginPackageSpecifier(packageName)).toThrow(
      ElizaError,
    );
    try {
      assertScenarioPluginPackageSpecifier(packageName);
    } catch (error) {
      expect(error).toMatchObject({
        code: "SCENARIO_PLUGIN_PACKAGE_SPECIFIER_INVALID",
        context: { packageName },
      });
    }
  });

  it.each([
    "unscoped-plugin",
    "unscoped-plugin/test-support",
    "@example/plugin",
    "@example/plugin/test-support",
    "@example/plugin/exports/feature+node",
  ])("accepts portable npm package specifier %s", (packageName) => {
    expect(() =>
      assertScenarioPluginPackageSpecifier(packageName),
    ).not.toThrow();
  });

  it("still fails clearly on a genuinely missing package plugin", async () => {
    const registerPlugin = vi.fn(async (_plugin: Plugin) => undefined);
    const runtime = { plugins: [], registerPlugin } as unknown as Pick<
      AgentRuntime,
      "plugins" | "registerPlugin"
    >;

    await expect(
      registerScenarioRequiredPlugins(
        runtime,
        ["@elizaos/plugin-does-not-exist"],
        "simulated",
      ),
    ).rejects.toThrow(/@elizaos\/plugin-does-not-exist/u);
    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it("attempts unscoped package imports instead of silently treating them as fixtures", async () => {
    const registerPlugin = vi.fn(async (_plugin: Plugin) => undefined);
    const runtime = { plugins: [], registerPlugin } as unknown as Pick<
      AgentRuntime,
      "plugins" | "registerPlugin"
    >;

    await expect(
      registerScenarioRequiredPlugins(
        runtime,
        ["unscoped-plugin-does-not-exist"],
        "simulated",
      ),
    ).rejects.toThrow(/unscoped-plugin-does-not-exist/u);
    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it("resolves installed unscoped packages before validating their Plugin export", async () => {
    const registerPlugin = vi.fn(async (_plugin: Plugin) => undefined);
    const runtime = { plugins: [], registerPlugin } as unknown as Pick<
      AgentRuntime,
      "plugins" | "registerPlugin"
    >;

    await expect(
      registerScenarioRequiredPlugins(runtime, ["ws"], "simulated"),
    ).rejects.toThrow(/ws did not export a Plugin/u);
    expect(registerPlugin).not.toHaveBeenCalled();
  });

  it("loads an exported package subpath", async () => {
    const plugins: Plugin[] = [];
    const registerPlugin = vi.fn(async (plugin: Plugin) => {
      plugins.push(plugin);
    });
    const runtime = { plugins, registerPlugin } as unknown as Pick<
      AgentRuntime,
      "plugins" | "registerPlugin"
    >;

    await expect(
      registerScenarioRequiredPlugins(
        runtime,
        ["@elizaos/plugin-maps/plugin"],
        "simulated",
      ),
    ).resolves.toEqual(["@elizaos/plugin-maps/plugin"]);
    expect(plugins.map((plugin) => plugin.name)).toEqual(["maps"]);
  });

  it("does not register an already-present declared plugin twice", async () => {
    const plugins: Plugin[] = [
      { name: "maps", description: "Already registered Maps", actions: [] },
    ];
    const registerPlugin = vi.fn(async (_plugin: Plugin) => undefined);
    const runtime = { plugins, registerPlugin } as unknown as Pick<
      AgentRuntime,
      "plugins" | "registerPlugin"
    >;

    await registerScenarioRequiredPlugins(
      runtime,
      ["@elizaos/plugin-maps"],
      "simulated",
    );
    expect(registerPlugin).not.toHaveBeenCalled();
  });
});

describe("shared runtime plugin safety", () => {
  const scenario = (id: string, plugins: string[]) =>
    ({
      id,
      title: id,
      domain: "meetings",
      turns: [],
      requires: { plugins },
    }) as const;

  it("accepts a dependency-homogeneous meetings test batch", () => {
    expect(() =>
      assertSharedRuntimePluginBatchSafe([
        scenario("mock-a", [
          "@elizaos/plugin-meetings",
          "@elizaos/plugin-meetings/test-support",
        ]),
        scenario("mock-b", [
          "@elizaos/plugin-meetings",
          "@elizaos/plugin-meetings/test-support",
        ]),
      ]),
    ).not.toThrow();
  });

  it("rejects a shared mock and production meetings batch", () => {
    expect(() =>
      assertSharedRuntimePluginBatchSafe([
        scenario("mock", [
          "@elizaos/plugin-meetings",
          "@elizaos/plugin-meetings/test-support",
        ]),
        scenario("live", ["@elizaos/plugin-meetings"]),
      ]),
    ).toThrow(/unsafe shared meetings batch.*mock.*live/u);
  });

  it("rejects an undeclared action scenario that could inherit ambient meeting test support", () => {
    const undeclaredActionScenario = {
      id: "ambient-false-green",
      title: "Ambient false green",
      domain: "other",
      turns: [
        {
          kind: "action",
          name: "invokes meetings without declaring its dependency",
          actionName: "JOIN_MEETING",
          parameters: { meetingUrl: "https://meet.google.com/abc-defg-hij" },
        },
      ],
    } as const;

    expect(() =>
      assertSharedRuntimePluginBatchSafe([
        scenario("declared-mock", [
          "@elizaos/plugin-meetings",
          "@elizaos/plugin-meetings/test-support",
        ]),
        undeclaredActionScenario,
      ]),
    ).toThrow(
      /every scenario sharing that runtime must explicitly declare.*ambient-false-green/u,
    );
  });

  it("rejects test support without its production plugin", () => {
    expect(() =>
      assertSharedRuntimePluginBatchSafe([
        scenario("orphan", ["@elizaos/plugin-meetings/test-support"]),
      ]),
    ).toThrow(/declares meetings test support without/u);
  });
});
