/** Real loopback HTTP and registered-view delivery, with actor roles and renderer targets isolated. */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Action,
  AgentRuntime,
  type ContextObject,
  type ContextProviderEvent,
  ContextRegistry,
  type GenerateTextParams,
  type GenerateTextResult,
  getStreamingContext,
  type IAgentRuntime,
  isObjectRecord,
  type Memory,
  type MessageHandlerResult,
  MODEL_CANONICAL_CONTEXT,
  ModelType,
  projectDeferredProviders,
  promoteSubactionsToActions,
  ResponseHandlerFieldRegistry,
  registerDirectActionRoutingRule,
  runResponseHandlerEvaluators,
  runWithStreamingContext,
  runWithTrajectoryContext,
  type ToolDefinition,
  type UUID,
} from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiContextProvider } from "../../../plugins/plugin-assistant/src/features/basic-capabilities/providers/uiContext.ts";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../../plugins/plugin-assistant/src/runtime/builtin-field-evaluators.ts";
import { runEvaluator } from "../../../plugins/plugin-assistant/src/runtime/evaluator.ts";
import {
  actionResultToPlannerToolResult,
  runPlannerLoop,
} from "../../../plugins/plugin-assistant/src/runtime/planner-loop.ts";
import { toolMessageContent } from "../../../plugins/plugin-assistant/src/runtime/planner-rendering.ts";
import {
  collectV5PlannerCandidateActions,
  retrieveContextualPlannerActions,
} from "../../../plugins/plugin-assistant/src/services/message/action-surface.ts";
import { runV5MessageRuntimeStage1 } from "../../../plugins/plugin-assistant/src/services/message/pipeline.ts";
import { collectBudgetedStageOneCandidateActions } from "../../../plugins/plugin-assistant/src/services/message/planned-tool.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "../../../plugins/plugin-assistant/src/services/message/stage1-evaluators.ts";
import { renderMessageHandlerModelInput } from "../../../plugins/plugin-assistant/src/services/message/stage1-input.ts";
import { createPlannerToolDiscoveryAction } from "../../../plugins/plugin-assistant/src/services/message/tool-discovery.ts";
import { DefaultMessageService } from "../../../plugins/plugin-assistant/src/services/message.ts";
import { calendarAction } from "../../../plugins/plugin-calendar/src/actions/calendar.ts";
import { calendarReadBindingEvaluator } from "../../../plugins/plugin-calendar/src/read-binding.ts";
import { notesPlugin } from "../../../plugins/plugin-notes/src/plugin.ts";
import { briefAction } from "../../../plugins/plugin-personal-assistant/src/actions/brief.ts";
import { createTrackedWorkRecapDirectRoutingRule } from "../../../plugins/plugin-personal-assistant/src/lifeops/briefing/direct-routing.ts";
import { viewsAction } from "../src/actions/views.ts";
import { registerInProcessApi } from "../src/api/in-process-api.ts";
import { normalizeWsClientId } from "../src/api/server-helpers-auth.ts";
import { closeViewInteractionHost } from "../src/api/view-interaction-host.ts";
import {
  closeRuntimeViewRegistry,
  getView,
  registerBuiltinViews,
  registerPluginViews,
} from "../src/api/views-registry.ts";
import {
  getCurrentViewState,
  handleViewsRoutes,
} from "../src/api/views-routes.ts";
import { createElizaPlugin } from "../src/runtime/eliza-plugin.ts";
import { installPromptOptimizations } from "../src/runtime/prompt-optimization.ts";
import {
  activeViewSourceEvaluator,
  capturedActiveViewSource,
} from "../src/runtime/view-action-affinity.ts";
import { runWithViewClient } from "../src/runtime/view-client-context.ts";
import {
  viewNavigationEvaluator,
  viewNavigationField,
} from "../src/runtime/view-navigation.ts";

const owner = "11111111-1111-4111-8111-111111111111" as UUID;
const room = "22222222-2222-4222-8222-222222222222" as UUID;
const message: Memory = {
  id: "33333333-3333-4333-8333-333333333333" as UUID,
  entityId: owner,
  roomId: room,
  content: { text: "Open Notes", metadata: { viewClientId: "origin-client" } },
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  vi.unstubAllEnvs();
});
async function fixture(
  delivered = 1,
  suppliedRuntime?: IAgentRuntime,
  handleTurn?: () => Promise<unknown>,
  inProcess = false,
) {
  const frames: Array<{ client: string; frame: object }> = [];
  let requests = 0;
  let kernelRequests = 0;
  const runtime =
    suppliedRuntime ??
    ({
      agentId: "44444444-4444-4444-8444-444444444444",
      actions: [viewsAction],
      responseHandlerEvaluators: [viewNavigationEvaluator],
      getRoom: async () => ({ worldId: "world" }),
      getWorld: async () => ({
        id: "world",
        metadata: {
          roles: { [owner]: "OWNER" },
          ownership: { ownerId: owner },
        },
      }),
      getSetting: () => undefined,
      getEntityById: async () => null,
      emitEvent: async () => undefined,
      reportError: vi.fn(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as IAgentRuntime);
  registerBuiltinViews(runtime);
  await registerPluginViews(
    runtime,
    {
      name: "test-nav-views",
      description: "Fixture view owner",
      views: [
        { id: "notes", label: "Notes", path: "/notes", bundleUrl: "/notes.js" },
        {
          id: "calendar",
          label: "Calendar",
          path: "/calendar",
          bundleUrl: "/calendar.js",
        },
      ],
    },
    { pluginDir: process.cwd(), indexEmbeddings: false },
  );
  const hostKey = {};
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    requests++;
    const otherOwner =
      inProcess &&
      req.headers.authorization === "Bearer other-navigation-owner";
    if (
      req.headers.authorization !== "Bearer local-navigation-test" &&
      !otherOwner
    ) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/owned-source-turn" && handleTurn) {
      const clientId = normalizeWsClientId(req.headers["x-eliza-client-id"]);
      void runWithViewClient(
        clientId ? { hostKey, clientId } : undefined,
        handleTurn,
      )
        .then((result) =>
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(result)),
        )
        .catch((error) => res.writeHead(500).end(String(error)));
      return;
    }
    await handleViewsRoutes({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      hostKey,
      runtime,
      callerAuthorization: {
        ok: true,
        role: "OWNER",
        identityId: otherOwner ? "55555555-5555-4555-8555-555555555555" : owner,
      },
      json: (response, body) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      },
      error: (response, message, code = 500) => {
        response.writeHead(code, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: message }));
      },
      broadcastWsToClientId: (client, frame) => {
        frames.push({ client, frame });
        return delivered;
      },
      broadcastWs: () => {
        throw new Error("Global navigation is forbidden in this test");
      },
    }).catch((error) => {
      res.writeHead(500).end(String(error));
    });
  };
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  const unregister = inProcess
    ? registerInProcessApi(runtime, {
        handle: async (req, res) => {
          kernelRequests++;
          await handleRequest(req, res);
        },
      })
    : undefined;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("ELIZA_API_PORT", String((server.address() as AddressInfo).port));
  vi.stubEnv("ELIZA_API_TOKEN", "local-navigation-test");
  cleanup.push(async () => {
    unregister?.();
    closeViewInteractionHost(hostKey);
    closeRuntimeViewRegistry(runtime);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    runtime,
    frames,
    requests: () => requests,
    kernelRequests: () => kernelRequests,
    hostKey,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
async function show(runtime: IAgentRuntime, view: string, input = message) {
  return viewsAction.handler?.(runtime, input, undefined, {
    parameters: { action: "show", view },
  });
}
describe("host view navigation", () => {
  it("keeps evaluator target-selection instructions within the registered navigation contract", async () => {
    expect(
      viewsAction.parameters?.find((parameter) => parameter.name === "action")
        ?.schema.enum,
    ).toEqual(["list", "show"]);
    let prompt = "";
    const context = { id: "selection-contract", events: [] };
    await runEvaluator({
      context,
      trajectory: {
        context,
        steps: [],
        archivedSteps: [],
        plannedQueue: [],
        evaluatorOutputs: [],
      },
      runtime: {
        useModel: async (_type, options) => {
          prompt = JSON.stringify(options.messages);
          return JSON.stringify({
            decision: "CONTINUE",
            success: false,
            thought: "Target selection still requires a supported interaction.",
          });
        },
      },
    });
    expect(prompt).not.toContain("VIEWS interact");
    expect(prompt).toContain("registered scoped interaction action");
    expect(prompt).toContain("discover one if missing");
    expect(prompt).toContain(
      "fresh rendered state proving it selected and visible",
    );
    expect(prompt).toContain(
      "report that limitation rather than claim target selection",
    );
  });
  it("keeps canonical delivery evidence while deferring registry bulk to authorized view lookup", async () => {
    const f = await fixture();
    const capability = {
      id: "read-projection-fixture",
      description: "Complete capability grammar PROJECTION_FIXTURE_END ".repeat(
        40,
      ),
      params: {
        recordId: {
          type: "string",
          required: true,
          description: "Exact record identifier",
        },
      },
    };
    await registerPluginViews(
      f.runtime,
      {
        name: "projection-view-owner",
        description: "Registered lookup fixture",
        views: [
          {
            id: "projection-view",
            label: "Projection fixture",
            path: "/projection-fixture",
            bundleUrl: "/projection-fixture.js",
            capabilities: [capability],
          },
        ],
      },
      { pluginDir: process.cwd(), indexEmbeddings: false },
    );
    const result = await show(f.runtime, "projection-view");
    if (!result || typeof result === "boolean")
      throw new Error("Missing navigation result");
    const before = structuredClone(result);
    const wireText = toolMessageContent(
      actionResultToPlannerToolResult(result),
    );
    const wire = JSON.parse(wireText);
    expect(wire.success).toBe(true);
    expect(wire.text).toBe(result.text);
    expect(wire.data.navigation).toEqual(result.data?.navigation);
    for (const field of [
      "capabilities",
      "bundleUrl",
      "pluginDir",
      "installationId",
    ])
      expect(wireText).not.toContain(`"${field}":`);
    expect(wireText).not.toContain("PROJECTION_FIXTURE_END");
    expect(wireText).toContain("VIEWS_LIST");
    expect(result).toEqual(before);
    expect(result.data?.view).toMatchObject({
      id: "projection-view",
      capabilities: [capability],
      bundleUrl: "/projection-fixture.js",
    });
    const receipt = JSON.parse(result.text ?? "{}");
    expect(receipt).toEqual(result.data?.navigation);
    expect(result.values).toMatchObject({
      completedActionDelivered: true,
      completedActionHandoffId: receipt.handoffId,
    });
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0]).toMatchObject({
      client: "origin-client",
      frame: { completedActionHandoffId: receipt.handoffId },
    });
    const lookup = createElizaPlugin().actions?.find(
      (action) => action.name === "VIEWS_LIST",
    );
    if (!lookup?.handler) throw new Error("Missing advertised view lookup");
    const listing = await lookup.handler(f.runtime, message, undefined, {
      parameters: {},
    });
    if (!listing || typeof listing === "boolean")
      throw new Error("Missing view lookup result");
    expect(listing.data?.views).toEqual(
      expect.arrayContaining([result.data?.view]),
    );
    expect(
      toolMessageContent(actionResultToPlannerToolResult(listing)),
    ).toContain("PROJECTION_FIXTURE_END");
    expect(f.requests()).toBe(1); // Lookup uses the registry, not another navigation.
    f.runtime.getWorld = async () =>
      ({ id: "world", metadata: { roles: { [owner]: "USER" } } }) as never;
    const revoked = await lookup.handler(f.runtime, message, undefined, {
      parameters: {},
    });
    expect(revoked).toMatchObject({
      success: false,
      data: { navigation: { status: "forbidden" } },
    });
    expect(JSON.stringify(revoked)).not.toContain("PROJECTION_FIXTURE_END");
    expect(f.requests()).toBe(1);
  });
  it.each(["forbidden", "cancelled", "not-delivered"])(
    "keeps %s failures unprojected and never claims delivery",
    async (status) => {
      const f = await fixture(status === "not-delivered" ? 0 : 1);
      const input =
        status === "forbidden"
          ? {
              ...message,
              entityId: "55555555-5555-4555-8555-555555555555" as UUID,
            }
          : message;
      const abort = new AbortController();
      if (status === "cancelled") abort.abort();
      const result = await runWithStreamingContext(
        { abortSignal: abort.signal },
        () => show(f.runtime, "Notes", input),
      );
      if (!result || typeof result === "boolean")
        throw new Error("Missing failure result");
      expect(result).toMatchObject({
        success: false,
        data: { navigation: { status } },
      });
      expect(result.promptDataMode).toBeUndefined();
      expect(
        JSON.parse(toolMessageContent(actionResultToPlannerToolResult(result))),
      ).toMatchObject({
        success: false,
        data: { navigation: { status } },
      });
      expect(f.requests()).toBe(status === "not-delivered" ? 1 : 0);
    },
  );
  it("discovers the current host action and exposes separate list/show contracts", async () => {
    const f = await fixture();
    const loaded: unknown[] = [];
    const discovery = createPlannerToolDiscoveryAction(
      [viewsAction],
      (actions) => loaded.push(...actions),
      async () => [viewsAction],
      { deferNameIndex: true },
    );
    const found = await discovery.handler?.(f.runtime, message, undefined, {
      parameters: { query: "open Calendar view", contexts: ["general"] },
    });
    expect(found?.data?.loadedTools).toContain("VIEWS");
    expect(loaded).toContain(viewsAction);
    const result = await viewsAction.handler?.(f.runtime, message, undefined, {
      parameters: { action: "list" },
    });
    expect(result).toMatchObject({ success: true });
    expect(result && typeof result !== "boolean" && result.data?.views).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "notes" }),
        expect.objectContaining({ id: "calendar" }),
      ]),
    );
    expect(f.requests()).toBe(0);
  });
  it.each(["open view navigate notes", "VIEWS_SHOW open notes view"])(
    "discovers registered navigation operations beside browser tools: %s",
    async (query) => {
      const f = await fixture();
      const input = clientMessage();
      f.runtime.actions = [
        ...(createElizaPlugin().actions ?? []).filter((action) =>
          action.name.startsWith("VIEWS"),
        ),
        {
          name: "BROWSER_OPEN",
          description: "Open a browser tab and navigate to a web page view",
          contexts: ["general"],
          validate: async () => true,
          handler: async () => ({ success: true }),
        } as Action,
      ];
      const loaded: Action[] = [];
      let senderRole: "OWNER" | "USER" = "OWNER";
      const discovery = createPlannerToolDiscoveryAction(
        [],
        (actions) => loaded.push(...actions),
        (names) =>
          collectV5PlannerCandidateActions({
            runtime: f.runtime,
            message: input,
            state: { values: {}, data: {}, text: "" },
            selectedContexts: ["calendar"],
            candidateActions: names.length
              ? names
              : f.runtime.actions.map((a) => a.name),
            userRoles: [senderRole],
          }),
        { deferNameIndex: true },
      );
      const found = await discovery.handler?.(f.runtime, input, undefined, {
        parameters: { query },
      });
      expect(found?.data?.loadedTools).toContain("VIEWS_SHOW");
      expect(f.requests()).toBe(0);
      const navigate = loaded.find((action) => action.name === "VIEWS_SHOW");
      expect(navigate).toBeDefined();
      const result = await navigate?.handler?.(f.runtime, input, undefined, {
        parameters: { view: "notes" },
      });
      expect(result).toMatchObject({
        success: true,
        data: { navigation: { status: "delivered", path: "/notes" } },
      });
      expect(f.frames).toHaveLength(1);
      expect(f.frames[0].client).toBe("origin-client");
      senderRole = "USER";
      loaded.length = 0;
      const denied = await discovery.handler?.(f.runtime, input, undefined, {
        parameters: { query },
      });
      expect(denied?.data?.loadedTools).not.toContain("VIEWS_SHOW");
      expect(loaded.some((action) => action.name.startsWith("VIEWS"))).toBe(
        false,
      );
      expect(f.frames).toHaveLength(1);
    },
  );
  it.each(["delivered", "stale", "wrong-view", "rejected", "cancelled"])(
    "binds mixed queued reads to the actual %s navigation receipt",
    async (mode) => {
      const f = await fixture(mode === "rejected" ? 0 : 1);
      const input = clientMessage();
      const sequence: string[] = [];
      const evaluations: string[] = [];
      const navigation = createElizaPlugin().actions?.find(
        (action) => action.name === "VIEWS_SHOW",
      );
      if (!navigation?.handler) throw new Error("Missing navigation operation");
      let nonce: unknown;
      const result = await runPlannerLoop({
        context: {
          id: String(input.id),
          metadata: { roomId: input.roomId, messageId: input.id },
          events: [],
        },
        runtime: {
          useModel: async (): Promise<GenerateTextResult> => ({
            text: "",
            toolCalls: [
              {
                id: "navigate",
                name: "VIEWS_SHOW",
                arguments: {
                  view: "notes",
                  navigationStepId: "untrusted-model-value",
                  eliza_turn_scope: "more_work_pending",
                },
              },
              {
                id: "read",
                name: "READ_NOTE",
                arguments: { eliza_turn_scope: "more_work_pending" },
              },
            ],
          }),
        },
        executeToolCall: async (call) => {
          sequence.push(call.name);
          if (call.name === "VIEWS_SHOW") {
            nonce = call.params?.navigationStepId;
            const controller = new AbortController();
            if (mode === "cancelled") controller.abort();
            const received = await runWithStreamingContext(
              { abortSignal: controller.signal },
              () =>
                navigation.handler(f.runtime, input, undefined, {
                  parameters: {
                    view: "notes",
                    navigationStepId: String(nonce),
                  },
                }),
            );
            if (!received || typeof received === "boolean")
              throw new Error("Missing navigation result");
            if (mode === "stale" || mode === "wrong-view") {
              const receipt = received.data?.navigation as Record<
                string,
                unknown
              >;
              received.data = {
                ...received.data,
                navigation: {
                  ...receipt,
                  ...(mode === "stale"
                    ? { stepId: "old-execution" }
                    : { viewId: "calendar", label: "Calendar" }),
                },
              };
            }
            return received as never;
          }
          return { success: true, text: "Note read.", continueChain: false };
        },
        evaluate: async () => {
          evaluations.push(sequence.at(-1) ?? "");
          return {
            success: true,
            decision: "NEXT_RECOMMENDED",
            thought: "Inspect the remaining queued read.",
            recommendedToolCallId: "read",
            raw: {},
          };
        },
      });
      expect(result.terminalFailure).toBeUndefined();
      expect(sequence).toEqual(["VIEWS_SHOW", "READ_NOTE"]);
      if (mode === "delivered") expect(evaluations).not.toContain("VIEWS_SHOW");
      else expect(evaluations).toContain("VIEWS_SHOW");
      expect(typeof nonce).toBe("string");
      expect(nonce).not.toBe("untrusted-model-value");
      expect(f.frames).toHaveLength(mode === "cancelled" ? 0 : 1);
    },
  );
  it("rejects ambiguous labels rather than selecting an arbitrary view", async () => {
    const f = await fixture();
    await registerPluginViews(
      f.runtime,
      {
        name: "ambiguous-nav",
        description: "Ambiguous fixture",
        views: [{ id: "other-notes", label: "Notes", path: "/other-notes" }],
      },
      { pluginDir: process.cwd() },
    );
    expect(await show(f.runtime, "Notes")).toMatchObject({
      success: false,
      data: { navigation: { status: "ambiguous" } },
    });
    expect(f.requests()).toBe(0);
  });

  it.each(["Notes", "Calendar", "home"])(
    "delivers %s to only the originating renderer",
    async (view) => {
      const f = await fixture();
      const result = await show(f.runtime, view);
      expect(result).toMatchObject({
        success: true,
        data: {
          navigation: { effect: "view_navigation", status: "delivered" },
        },
      });
      expect(f.frames).toHaveLength(1);
      expect(f.frames[0].client).toBe("origin-client");
    },
  );
  it("refuses an absent renderer instead of claiming navigation", async () => {
    const f = await fixture(0);
    expect(await show(f.runtime, "Notes")).toMatchObject({ success: false });
  });
  it("rejects unknown targets and unbound clients before HTTP", async () => {
    const f = await fixture();
    expect(await show(f.runtime, "not-a-view")).toMatchObject({
      success: false,
    });
    expect(
      await show(f.runtime, "Notes", {
        ...message,
        content: { text: "Open Notes" },
      }),
    ).toMatchObject({ success: false });
    expect(f.requests()).toBe(0);
  });
  it("rejects a non-owner even with a valid renderer identifier", async () => {
    const f = await fixture();
    expect(
      await show(f.runtime, "Notes", {
        ...message,
        entityId: "55555555-5555-4555-8555-555555555555" as UUID,
      }),
    ).toMatchObject({ success: false });
    expect(f.requests()).toBe(0);
  });
  it("honors cancellation before route dispatch", async () => {
    const f = await fixture();
    const abort = new AbortController();
    abort.abort();
    expect(
      await runWithStreamingContext({ abortSignal: abort.signal }, () =>
        show(f.runtime, "Notes"),
      ),
    ).toMatchObject({ success: false });
    expect(f.requests()).toBe(0);
  });
});

async function selectNavigation(
  f: Awaited<ReturnType<typeof fixture>>,
  input: Memory,
  overrides = {},
  planOverrides = {},
  mutate?: () => void,
) {
  const fields = new ResponseHandlerFieldRegistry();
  fields.register(viewNavigationField);
  expect(fields.composeSchema().properties).toHaveProperty(
    "visualContinuation",
  );
  const handler = {
    processMessage: "RESPOND",
    plan: {
      requiresTool: true,
      contexts: ["general"],
      intents: ["Open Notes"],
      candidateActions: ["VIEWS"],
      reply: "Opened Notes.",
      replyEffectStatus: "pending",
      ...planOverrides,
    },
  } as MessageHandlerResult;
  await fields.dispatch({
    runtime: f.runtime,
    message: input,
    state: { values: {}, data: {}, text: "" },
    senderRole: "OWNER",
    turnSignal: new AbortController().signal,
    rawParsed: {
      visualContinuation: {
        disposition: "direct",
        viewId: "notes",
        reason: "Requested navigation",
        ...overrides,
      },
    },
  });
  mutate?.();
  await runResponseHandlerEvaluators({
    runtime: f.runtime,
    message: input,
    state: { values: {}, data: {}, text: "" },
    messageHandler: handler,
    availableContexts: [{ id: "general", description: "General" }],
    userRoles: ["OWNER"],
  });
  return handler;
}
const clientMessage = (): Memory => ({
  ...message,
  content: { ...message.content, source: "client_chat", channelType: "DM" },
});

describe("model-selected host navigation", () => {
  it.each([
    { verb: "Open", contexts: ["general", "notes", "calendar"] },
    { verb: "Switch to", contexts: ["general", "notes", "calendar"] },
    { verb: "Open", contexts: ["simple", "general"] },
    { verb: "Switch to", contexts: ["simple", "general"] },
  ])(
    "retains known show and both reads for $verb with $contexts",
    async ({ verb, contexts }) => {
      const f = await fixture();
      f.runtime.actions = [
        ...(createElizaPlugin().actions ?? []).filter((action) =>
          action.name.startsWith("VIEWS"),
        ),
        ...(notesPlugin.actions ?? []),
        ...promoteSubactionsToActions(calendarAction),
      ];
      const input = clientMessage();
      input.content.text =
        "Open Notes and read my latest existing note and my next saved Calendar event. Do not create, edit, or delete anything.";
      const intents = [
        `${verb} Notes view`,
        "Read latest existing note",
        "Read next saved Calendar event",
      ];
      const selected = await selectNavigation(
        f,
        input,
        { disposition: "planning", viewId: "notes" },
        { contexts, intents, candidateActions: [], reply: "" },
      );
      const initial = collectBudgetedStageOneCandidateActions({
        actions: f.runtime.actions,
        candidateActions: selected.plan.candidateActions ?? [],
        contexts: selected.plan.contexts,
        intents: selected.plan.intents,
        deferUnselectedContexts: true,
        deferParentHints: true,
      });
      const loaded = retrieveContextualPlannerActions({
        actions: f.runtime.actions,
        query: intents.join("\n"),
        intents,
        contexts: selected.plan.contexts,
        selectedActions: initial,
        contextAliases: (context) => (context === "notes" ? ["note"] : []),
      }).actions;
      expect(loaded.map((action) => action.name).sort()).toEqual([
        "CALENDAR_NEXT_EVENT",
        "NOTES_GET",
        "NOTES_LIST",
        "VIEWS_SHOW",
      ]);
      expect(selected.plan.candidateActions).toEqual(["VIEWS_SHOW"]);
      expect(selected.plan.intents).toEqual(intents);
      expect(selected.plan.deterministicToolCall).toBeUndefined();
      expect(f.requests()).toBe(0);
      const show = loaded.find((action) => action.name === "VIEWS_SHOW");
      const result = await show?.handler?.(f.runtime, input, undefined, {
        parameters: { view: "notes" },
      });
      expect(result).toMatchObject({
        success: true,
        data: { navigation: { status: "delivered", path: "/notes" } },
      });
      expect(f.frames).toHaveLength(1);
      expect(f.frames[0].client).toBe("origin-client");
    },
  );

  it("keeps an unknown destination discoverable through list without executing navigation", async () => {
    const f = await fixture();
    f.runtime.actions = (createElizaPlugin().actions ?? []).filter((action) =>
      action.name.startsWith("VIEWS"),
    );
    const input = clientMessage();
    const selected = await selectNavigation(
      f,
      input,
      { disposition: "planning", viewId: "unregistered" },
      { intents: ["Find the requested view"], candidateActions: [] },
    );
    expect(selected.plan.candidateActions).toEqual(["VIEWS"]);
    expect(selected.plan.deterministicToolCall).toBeUndefined();
    const loaded = collectBudgetedStageOneCandidateActions({
      actions: f.runtime.actions,
      candidateActions: selected.plan.candidateActions ?? [],
      contexts: selected.plan.contexts,
      intents: selected.plan.intents,
      deferUnselectedContexts: true,
      deferParentHints: true,
    });
    expect(loaded.map((action) => action.name)).toEqual(["VIEWS_LIST"]);
    expect(
      await loaded[0].handler?.(f.runtime, input, undefined, {
        parameters: {},
      }),
    ).toMatchObject({ success: true });
    expect(f.requests()).toBe(0);
  });

  it("keeps conditional known navigation in planning with its prerequisites intact", async () => {
    const f = await fixture();
    f.runtime.actions = (createElizaPlugin().actions ?? []).filter((action) =>
      action.name.startsWith("VIEWS"),
    );
    const intents = [
      "Read the requested note",
      "Switch to Notes only if the record exists",
    ];
    const selected = await selectNavigation(
      f,
      clientMessage(),
      { disposition: "planning", viewId: "notes" },
      { intents, candidateActions: [] },
    );
    expect(selected.plan.candidateActions).toEqual(["VIEWS_SHOW"]);
    expect(selected.plan.intents).toEqual(intents);
    expect(selected.plan.deterministicToolCall).toBeUndefined();
    expect(f.requests()).toBe(0);
  });

  it.each([
    ["Switch to Notes view", "Read the note"],
    ["Switch to Notes view"],
    ["Choose between Notes and Calendar after checking records"],
  ])(
    "retains list and show while navigation remains unresolved: %s",
    async (...intents) => {
      const f = await fixture();
      f.runtime.actions = (createElizaPlugin().actions ?? []).filter((action) =>
        action.name.startsWith("VIEWS"),
      );
      const selected = await selectNavigation(
        f,
        clientMessage(),
        { disposition: "unresolved", viewId: "notes" },
        {
          intents,
          candidateActions: [],
        },
      );
      expect(selected.plan.candidateActions).toEqual([
        "VIEWS_LIST",
        "VIEWS_SHOW",
      ]);
      const loaded = collectBudgetedStageOneCandidateActions({
        actions: f.runtime.actions,
        candidateActions: selected.plan.candidateActions ?? [],
        contexts: selected.plan.contexts,
        intents: selected.plan.intents,
        deferUnselectedContexts: true,
        deferParentHints: true,
      });
      expect(loaded.map((action) => action.name).sort()).toEqual([
        "VIEWS_LIST",
        "VIEWS_SHOW",
      ]);
      expect(selected.plan.deterministicToolCall).toBeUndefined();
      expect(JSON.stringify(selected)).toContain(
        "navigation remains unresolved",
      );
      expect(f.requests()).toBe(0);
    },
  );

  it("composes fresh view identity without changing schema or retaining another turn's view", async () => {
    const f = await fixture();
    const fields = new ResponseHandlerFieldRegistry();
    fields.register(viewNavigationField);
    const input = clientMessage();
    const ctx = {
      runtime: f.runtime,
      message: input,
      state: { values: {}, data: {}, text: "" },
      senderRole: "OWNER" as const,
      turnSignal: new AbortController().signal,
    };
    const schema = JSON.stringify(fields.composeSchema());
    input.content.metadata = {
      viewClientId: "origin-client",
      uiView: "notes",
      uiViewCapabilities: ["PRIVATE_CONTROL_SENTINEL"],
    };
    expect((await fields.composePromptSlices(ctx)).context).toContain(
      '"viewId":"notes","label":"Notes"',
    );
    input.content.metadata.uiView = "chat";
    const home = await fields.composePromptSlices(ctx);
    expect(home.context).toContain('"viewId":"chat","label":"Home"');
    expect(home.context).not.toContain('"viewId":"notes"');
    expect(home.context).not.toContain("PRIVATE_CONTROL_SENTINEL");
    for (const nativeTools of [false, true]) {
      const rendered = renderMessageHandlerModelInput(
        { character: { name: "Agent" } },
        { id: "request", events: [] },
        [],
        { nativeTools, responseHandlerContext: home.context },
      );
      expect(rendered.messages[1].content).toContain(home.context);
      expect(rendered.messages[0].content).not.toContain(home.context);
      expect(
        rendered.promptSegments.find((segment) =>
          segment.content.includes(home.context),
        )?.stable,
      ).toBe(false);
    }
    expect(JSON.stringify(fields.composeSchema())).toBe(schema);
    input.content.metadata.uiView = "unknown-view";
    expect((await fields.composePromptSlices(ctx)).context).toBe("");
    input.content.metadata.uiView = "chat";
    input.content.source = "external";
    expect((await fields.composePromptSlices(ctx)).context).toBe("");
    expect(f.requests()).toBe(0);
  });
  it("does not expose a view outside the current caller's role", async () => {
    const f = await fixture();
    await registerPluginViews(
      f.runtime,
      {
        name: "restricted-test",
        description: "Restricted view",
        views: [
          {
            id: "restricted",
            label: "PRIVATE_VIEW_SENTINEL",
            path: "/restricted",
            roleGate: { minRole: "OWNER" },
          },
        ],
      },
      { pluginDir: process.cwd(), indexEmbeddings: false },
    );
    const fields = new ResponseHandlerFieldRegistry();
    fields.register(viewNavigationField);
    const input = clientMessage();
    input.content.metadata = {
      viewClientId: "origin-client",
      uiView: "restricted",
    };
    const ctx = {
      runtime: f.runtime,
      message: input,
      state: { values: {}, data: {}, text: "" },
      senderRole: "USER" as const,
      turnSignal: new AbortController().signal,
    };
    expect((await fields.composePromptSlices(ctx)).context).toBe("");
    expect(f.requests()).toBe(0);
  });
  it.each([
    [
      "notes",
      [
        "Open Notes view",
        "Read latest existing note",
        "Read next saved calendar event",
      ],
      true,
    ],
    ["notes", ["Open Notes only if the requested record exists"], true],
    [
      "notes",
      ["Choose between Notes and Calendar after checking records"],
      true,
    ],
    ["unknown-view", ["Open the unspecified destination"], false],
  ] as const)(
    "offers tools without resolving ambiguous navigation to %s",
    async (viewId, intents, known) => {
      const f = await fixture();
      f.runtime.actions = (createElizaPlugin().actions ?? []).filter((action) =>
        action.name.startsWith("VIEWS"),
      );
      const selected = await selectNavigation(
        f,
        clientMessage(),
        {
          disposition: "unresolved",
          viewId,
        },
        {
          contexts: ["general", "notes", "calendar"],
          intents: [...intents],
          candidateActions: [],
          reply: "",
        },
      );
      expect(selected.plan.intents).toEqual(intents);
      expect(selected.plan.deterministicToolCall).toBeUndefined();
      expect(f.requests()).toBe(0);
      expect(selected.plan.candidateActions).toEqual(
        known ? ["VIEWS_LIST", "VIEWS_SHOW"] : [],
      );
      if (known) {
        const actions = await collectV5PlannerCandidateActions({
          runtime: f.runtime,
          message: clientMessage(),
          state: { values: {}, data: {}, text: "" },
          selectedContexts: ["general", "notes", "calendar"],
          candidateActions: selected.plan.candidateActions,
          userRoles: ["OWNER"],
        });
        expect(actions.map((action) => action.name)).toEqual(
          expect.arrayContaining(["VIEWS_LIST", "VIEWS_SHOW"]),
        );
        expect(JSON.stringify(selected)).toContain("unresolved");
      }
    },
  );

  it.each(["none", "forbidden"])(
    "preserves domain-only work from Calendar with %s navigation",
    async (disposition) => {
      const f = await fixture();
      f.runtime.actions = (createElizaPlugin().actions ?? []).filter((action) =>
        action.name.startsWith("VIEWS"),
      );
      const input = clientMessage();
      input.content.text =
        "Create a note named Input audit September 25 with the exact text: The audit token is amber.";
      input.content.metadata = {
        viewClientId: "origin-client",
        uiView: "calendar",
      };
      const intents = [String(input.content.text)];
      const selected = await selectNavigation(
        f,
        input,
        {
          disposition,
          viewId: "",
        },
        {
          contexts: ["notes"],
          intents,
          candidateActions: ["NOTES"],
          reply: "",
        },
      );
      expect(selected.plan.contexts).toEqual(["notes"]);
      expect(selected.plan.intents).toEqual(intents);
      expect(selected.plan.candidateActions).toEqual(["NOTES"]);
      expect(selected.plan.replyEffectStatus).toBe("pending");
      expect(selected.plan.deterministicToolCall).toBeUndefined();
      expect(f.requests()).toBe(0);
    },
  );
  it("preserves a domain clarification without granting navigation or execution", async () => {
    const f = await fixture();
    const input = clientMessage();
    input.content.text = "Draft a note, but ask before saving it.";
    const selected = await selectNavigation(
      f,
      input,
      {
        disposition: "none",
        viewId: "",
      },
      {
        contexts: ["notes"],
        intents: [],
        candidateActions: ["NOTES"],
        requiresTool: false,
        reply: "Save this draft?",
        replyEffectStatus: "non_applied",
      },
    );
    expect(selected.plan.intents).toEqual([]);
    expect(selected.plan.requiresTool).toBe(false);
    expect(selected.plan.replyEffectStatus).toBe("non_applied");
    expect(selected.plan.reply).toBe("Save this draft?");
    expect(selected.plan.deterministicToolCall).toBeUndefined();
    expect(f.requests()).toBe(0);
  });
  it("selects the existing action without inference and delivers through the real originating-client route", async () => {
    const f = await fixture();
    const input = clientMessage();
    const selected = await selectNavigation(f, input, { viewId: "chat" });
    expect(selected.plan.deterministicToolCall).toEqual({
      name: "VIEWS",
      params: { action: "show", view: "chat" },
    });
    expect(f.requests()).toBe(0);
    const result = await viewsAction.handler?.(f.runtime, input, undefined, {
      parameters: selected.plan.deterministicToolCall?.params,
    });
    expect(result).toMatchObject({
      success: true,
      modelReplyRequired: true,
      data: { navigation: { status: "delivered" } },
    });
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0].client).toBe("origin-client");
    const again = {
      ...selected,
      plan: { ...selected.plan, deterministicToolCall: undefined },
    };
    await runResponseHandlerEvaluators({
      runtime: f.runtime,
      message: input,
      state: { values: {}, data: {}, text: "" },
      messageHandler: again,
      availableContexts: [],
      userRoles: ["OWNER"],
    });
    expect(again.plan.deterministicToolCall).toBeUndefined();
  });
  it.each(["text", "actor", "room", "id", "client"])(
    "rejects changed %s binding",
    async (field) => {
      const f = await fixture();
      const input = clientMessage();
      const selected = await selectNavigation(f, input, {}, {}, () => {
        if (field === "text") input.content.text = "Different request";
        else if (field === "client")
          input.content.metadata = { viewClientId: "different-client" };
        else if (field === "actor") input.entityId = room;
        else if (field === "room") input.roomId = owner;
        else input.id = room;
      });
      expect(selected.plan.deterministicToolCall).toBeUndefined();
      expect(f.requests()).toBe(0);
    },
  );
  it.each([
    ["compound", "notes", ["Read notes", "Open Notes"], ["NOTES_LIST"]],
    [
      "conditional",
      "notes",
      ["Open Notes only if the record exists"],
      ["VIEWS"],
    ],
    [
      "multiple destinations",
      "notes",
      ["Open Notes, then Calendar"],
      ["VIEWS"],
    ],
    ["unknown", "unregistered", ["Open the requested destination"], ["VIEWS"]],
  ])(
    "keeps %s navigation and domain work in the planner",
    async (_mode, viewId, intents, candidateActions) => {
      const f = await fixture();
      const selected = await selectNavigation(
        f,
        clientMessage(),
        { disposition: "planning", viewId },
        { intents, candidateActions },
      );
      expect(selected.plan.deterministicToolCall).toBeUndefined();
      expect(selected.plan.candidateActions).toEqual([
        ...new Set([...candidateActions, "VIEWS"]),
      ]);
      expect(selected.plan.intents).toEqual(intents);
      expect(f.requests()).toBe(0);
    },
  );
  it.each(["forbidden", "none", "unresolved", "optional"])(
    "does not directly execute %s",
    async (disposition) => {
      const f = await fixture();
      f.runtime.actions = (createElizaPlugin().actions ?? []).filter((action) =>
        action.name.startsWith("VIEWS"),
      );
      const input = clientMessage();
      await runWithStreamingContext(
        { messageId: String(input.id), onStreamChunk: () => {} },
        async () => {
          const selected = await selectNavigation(f, input, { disposition });
          expect(selected.plan.deterministicToolCall).toBeUndefined();
          if (disposition === "forbidden" || disposition === "none") {
            expect(await show(f.runtime, "Notes", input)).toMatchObject({
              success: false,
              data: { navigation: { status: "forbidden" } },
            });
            expect(
              await viewsAction.handler(f.runtime, input, undefined, {
                parameters: { action: "list" },
              }),
            ).toMatchObject({ success: true });
          }
        },
      );
      expect(f.requests()).toBe(0);
    },
  );
  it.each(["direct", "planning", "unresolved"])(
    "rechecks owner role and cancellation for %s",
    async (disposition) => {
      const f = await fixture();
      f.runtime.actions = (createElizaPlugin().actions ?? []).filter((action) =>
        action.name.startsWith("VIEWS"),
      );
      const input = clientMessage();
      const roleChanged = await selectNavigation(
        f,
        input,
        { viewId: "chat", disposition },
        { candidateActions: [] },
        () => {
          f.runtime.getWorld = async () =>
            ({
              id: "world",
              metadata: { roles: { [owner]: "USER" } },
            }) as never;
        },
      );
      expect(roleChanged.plan.deterministicToolCall).toBeUndefined();
      expect(roleChanged.plan.candidateActions).toEqual([]);
      const other = await fixture();
      other.runtime.actions = (createElizaPlugin().actions ?? []).filter(
        (action) => action.name.startsWith("VIEWS"),
      );
      const controller = new AbortController();
      await runWithStreamingContext(
        {
          messageId: String(input.id),
          abortSignal: controller.signal,
          onStreamChunk: () => {},
        },
        async () => {
          const selected = await selectNavigation(
            other,
            clientMessage(),
            { viewId: "chat", disposition },
            { candidateActions: [] },
            () => controller.abort(),
          );
          expect(selected.plan.deterministicToolCall).toBeUndefined();
          expect(selected.plan.candidateActions).toEqual([]);
        },
      );
      expect(f.requests() + other.requests()).toBe(0);
    },
  );
  it("does not substitute a direct call for contradictory non-navigation hints", async () => {
    const f = await fixture();
    const selected = await selectNavigation(
      f,
      clientMessage(),
      { viewId: "chat" },
      { candidateActions: ["NOTES_LIST"] },
    );
    expect(selected.plan.deterministicToolCall).toBeUndefined();
    expect(selected.plan.candidateActions).toContain("NOTES_LIST");
    expect(selected.plan.candidateActions).toContain("VIEWS");
  });
  it.each([
    { disposition: "requested", singleViewOnly: false, navigationOnly: true },
    { disposition: "direct", singleViewOnly: false, navigationOnly: true },
    { disposition: ["direct", "planning"] },
  ])(
    "rejects conflicting legacy or multiple routing states: %j",
    async (decision) => {
      const f = await fixture();
      const selected = await selectNavigation(f, clientMessage(), decision);
      expect(selected.plan.deterministicToolCall).toBeUndefined();
      expect(f.requests()).toBe(0);
      expect(f.frames).toHaveLength(0);
    },
  );

  it("ignores missing, malformed and client-metadata decisions", async () => {
    const f = await fixture();
    for (const disposition of [
      "invalid",
      null,
      undefined,
      42,
      true,
      ["direct"],
      ["planning"],
      ["none"],
      ["forbidden"],
      { toString: () => "direct" },
    ]) {
      const input = clientMessage();
      input.content.metadata = {
        viewClientId: "origin-client",
        visualContinuation: {
          disposition: "direct",
          viewId: "chat",
        },
      };
      expect(
        viewNavigationField.parse?.(
          { disposition, viewId: "chat", reason: "Malformed field" },
          {
            runtime: f.runtime,
            message: input,
            state: { values: {}, data: {}, text: "" },
            senderRole: "OWNER",
            turnSignal: new AbortController().signal,
          },
        ),
      ).toBeNull();
      const selected = await selectNavigation(f, input, {
        disposition,
        viewId: "chat",
      });
      expect(selected.plan.deterministicToolCall).toBeUndefined();
    }
    expect(f.requests()).toBe(0);
  });
  it.each([
    { reply: "Home.", wrongDestination: false },
    { reply: "Chat is open.", wrongDestination: false },
    { reply: "Messages is open.", wrongDestination: true },
    { reply: "Calendar is open.", wrongDestination: true },
  ])(
    "runs the canonical pipeline and gates the held reply ($reply)",
    async ({ reply, wrongDestination }) => {
      const f = await fixture();
      const input = clientMessage();
      input.content.text = "Open Home";
      input.content.metadata = {
        viewClientId: "origin-client",
        uiView: "notes",
        uiViewCapabilities: ["PRIVATE_CONTROL_SENTINEL"],
      };
      const fields = new ResponseHandlerFieldRegistry();
      for (const field of [
        ...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
        viewNavigationField,
      ])
        fields.register(field);
      const state = { values: {}, data: { providers: {} }, text: "" };
      const recoveryRequired = new Error("reply recovery required");
      const useModel = vi.fn(async (type: string, params: unknown) => {
        if (wrongDestination && type !== ModelType.RESPONSE_HANDLER)
          throw recoveryRequired;
        expect(type).toBe(ModelType.RESPONSE_HANDLER);
        expect(useModel).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(params)).toContain("visualContinuation");
        // Verify the host contract reaches the real Stage 1 model request.
        expect(JSON.stringify(params)).toContain(
          JSON.stringify(viewNavigationField.description).slice(1, -1),
        );
        const request = params as {
          messages: Array<{ role: string; content: string }>;
          tools: ToolDefinition[];
        };
        const handlerSchema = request.tools.find(
          (tool) => tool.name === "HANDLE_RESPONSE",
        )?.parameters;
        expect(handlerSchema?.properties).toHaveProperty("visualContinuation");
        expect(handlerSchema?.properties).not.toHaveProperty(
          "candidateActionNames",
        );
        expect(viewNavigationField.description).not.toContain(
          "candidateActionNames",
        );
        for (const field of [
          "intents",
          "contexts",
          "replyEffectStatus",
          "replyText",
        ]) {
          expect(handlerSchema?.properties).toHaveProperty(field);
        }
        expect(
          request.messages.find((entry) => entry.role === "user")?.content,
        ).toContain('"viewId":"notes","label":"Notes"');
        expect(
          request.messages.find((entry) => entry.role === "system")?.content,
        ).not.toContain("Current request's renderer view");
        expect(JSON.stringify(params)).not.toContain(
          "PRIVATE_CONTROL_SENTINEL",
        );
        return {
          text: "",
          toolCalls: [
            {
              name: "HANDLE_RESPONSE",
              arguments: {
                shouldRespond: "RESPOND",
                contexts: ["general"],
                contextRequests: [],
                intents: ["Open Home"],
                replyText: reply,
                replyEffectStatus: "pending",
                facts: [],
                relationships: [],
                topics: [],
                addressedTo: [],
                emotion: "none",
                visualContinuation: {
                  disposition: "direct",
                  viewId: "chat",
                  reason: "Only requested navigation",
                },
              },
            },
          ],
          finishReason: "tool-calls",
        };
      });
      Object.assign(
        f.runtime,
        createMockRuntime({
          ...f.runtime,
          character: { name: "Agent", bio: [] },
          contexts: new ContextRegistry([
            { id: "general", description: "General tasks" },
          ]),
          responseHandlerFieldRegistry: fields,
          responseHandlerFieldEvaluators: [...fields.list()],
          responseHandlerEvaluators: [viewNavigationEvaluator],
          providers: [],
          evaluators: [],
          runActionsByMode: async () => [],
          getModelRegistrations: () => [],
          useModel: useModel as unknown as IAgentRuntime["useModel"],
          composeState: async () => state,
        }),
      );
      const resultPromise = runWithStreamingContext(
        { messageId: String(input.id), onStreamChunk: () => {} },
        () =>
          runV5MessageRuntimeStage1({
            runtime: f.runtime,
            state,
            message: input,
            responseId: "55555555-5555-4555-8555-555555555555" as UUID,
          }),
      );
      if (wrongDestination) {
        const result = await resultPromise;
        expect(result).toMatchObject({
          kind: "direct_reply",
          result: {
            requestFulfilled: false,
            terminalFailure: { code: "PLANNER_INTERRUPTED_AFTER_ACTION" },
            actionResults: [
              {
                success: true,
                values: { completedActionDelivered: true, viewId: "chat" },
              },
            ],
          },
        });
        if (result.kind !== "direct_reply") {
          throw new Error("Expected receipt-preserving direct failure reply");
        }
        if (!result.result.responseContent) {
          throw new Error("Expected visible failure reply content");
        }
        expect(result.result.responseContent.text).not.toBe(reply);
      } else {
        const result = await resultPromise;
        expect(useModel).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
          kind: "planned_reply",
          result: { responseContent: { text: reply } },
        });
      }
      expect(f.frames).toHaveLength(1);
    },
  );
  it.each([
    {
      name: "forbidden navigation with an unsupported confirmation",
      disposition: "forbidden",
      currentView: "chat",
      request: "Do not change views. Tell me what you can do.",
      reply: "Notes is open.",
      needsRecovery: true,
    },
    {
      name: "ordinary conversation without navigation",
      disposition: "none",
      currentView: "chat",
      request: "Hello",
      reply: "Hello!",
      needsRecovery: false,
    },
    {
      name: "a truthful statement about the current view",
      disposition: "none",
      currentView: "notes",
      request: "Which view is open? Do not change views.",
      reply: "Notes is open.",
      needsRecovery: false,
    },
  ])("guards the final pipeline reply for $name", async (scenario) => {
    const f = await fixture();
    const input = clientMessage();
    input.content.text = scenario.request;
    input.content.metadata = {
      ...(isObjectRecord(input.content.metadata) ? input.content.metadata : {}),
      uiView: scenario.currentView,
      uiViewPath: scenario.currentView === "notes" ? "/notes" : "/chat",
    };
    const fields = new ResponseHandlerFieldRegistry();
    for (const field of [
      ...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
      viewNavigationField,
    ])
      fields.register(field);
    const initialState = { values: {}, data: { providers: {} }, text: "" };
    const uiContext = await uiContextProvider.get(
      f.runtime,
      input,
      initialState,
    );
    const state = {
      values: uiContext.values ?? {},
      data: { providers: { UI_CONTEXT: uiContext } },
      text: uiContext.text ?? "",
    };
    const recoveryRequired = new Error(
      "unsupported navigation reply requires recovery",
    );
    const useModel = vi.fn(async (type: string) => {
      if (type !== ModelType.RESPONSE_HANDLER) throw recoveryRequired;
      expect(useModel).toHaveBeenCalledTimes(1);
      return {
        text: "",
        toolCalls: [
          {
            name: "HANDLE_RESPONSE",
            arguments: {
              shouldRespond: "RESPOND",
              contexts: ["simple"],
              contextRequests: [],
              intents: [],
              candidateActionNames: [],
              replyText: scenario.reply,
              replyEffectStatus: "none",
              facts: [],
              relationships: [],
              topics: [],
              addressedTo: [],
              emotion: "none",
              visualContinuation: {
                disposition: scenario.disposition,
                viewId: "",
                reason: "The current request does not authorize navigation",
              },
            },
          },
        ],
        finishReason: "tool-calls",
      };
    });
    Object.assign(
      f.runtime,
      createMockRuntime({
        ...f.runtime,
        character: { name: "Agent", bio: [] },
        contexts: new ContextRegistry([
          { id: "general", description: "General tasks" },
        ]),
        responseHandlerFieldRegistry: fields,
        responseHandlerFieldEvaluators: [...fields.list()],
        responseHandlerEvaluators: [viewNavigationEvaluator],
        providers: [],
        evaluators: [],
        runActionsByMode: async () => [],
        getModelRegistrations: () => [],
        useModel: useModel as unknown as IAgentRuntime["useModel"],
        composeState: async () => state,
      }),
    );
    const result = runWithStreamingContext(
      { messageId: String(input.id), onStreamChunk: () => {} },
      () =>
        runV5MessageRuntimeStage1({
          runtime: f.runtime,
          state,
          message: input,
          responseId: "55555555-5555-4555-8555-555555555555" as UUID,
        }),
    );
    const [settled] = await Promise.allSettled([result]);
    expect(f.requests()).toBe(0);
    expect(f.frames).toHaveLength(0);
    if (scenario.needsRecovery) {
      expect(settled).toMatchObject({
        status: "rejected",
        reason: { code: "REPLY_GROUNDING_FAILED" },
      });
    } else {
      expect(settled).toMatchObject({
        status: "fulfilled",
        value: {
          kind: "direct_reply",
          result: { responseContent: { text: scenario.reply } },
        },
      });
      expect(useModel).toHaveBeenCalledTimes(1);
    }
  });
});

describe("inferred visual scope invalidation", () => {
  const briefRequest =
    "Give me my daily dossier using the connected sources available now.";
  const visual480 = {
    disposition: "planning",
    viewId: "Home",
    reason:
      "Requests a composite daily dossier; needs multiple source reads before composing, so navigation is part of the planning scope rather than a satisfying direct view.",
  };
  async function staged(
    text = briefRequest,
    value = visual480,
    registerOwner = true,
  ) {
    const f = await fixture();
    const input = clientMessage();
    input.createdAt = 1000;
    input.content.text = text;
    input.content.metadata = {
      uiTab: "chat",
      uiBrowserSurface: "native",
      uiTimeZone: "America/Los_Angeles",
      viewClientId: "origin-client",
    };
    f.runtime.actions.push({ ...briefAction, validate: async () => true });
    if (registerOwner)
      registerDirectActionRoutingRule(
        f.runtime,
        createTrackedWorkRecapDirectRoutingRule(),
      );
    const fields = new ResponseHandlerFieldRegistry();
    fields.register(viewNavigationField);
    const state = { values: {}, data: {}, text: "" };
    await fields.dispatch({
      runtime: f.runtime,
      message: input,
      state,
      senderRole: "OWNER",
      turnSignal: new AbortController().signal,
      rawParsed: {
        visualContinuation: value,
        invalidatedScopeFields: ["visualContinuation"],
      },
    });
    const handler: MessageHandlerResult = {
      processMessage: "RESPOND",
      thought: "",
      plan: {
        contexts: [
          "productivity",
          "calendar",
          "tasks",
          "todos",
          "health",
          "screen_time",
          "connectors",
          "notes",
          "lifeops",
        ],
        intents: [
          "Compile the daily dossier using the connected sources available now",
        ],
        replyEffectStatus: "pending",
        requiresTool: true,
        calendarReadBindings: [
          {
            intentId: "intent:1",
            operation: "feed",
            execution: "required",
            sourceMessageId: input.id ?? "",
            roomId: input.roomId,
            actorId: input.entityId,
            requestedAt: 1000,
          },
        ],
        contextSlices: ["Existing authorized source context"],
      },
    };
    const direct = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
      (evaluator) =>
        evaluator.name === "core.direct_registered_capability_request",
    );
    if (!direct) throw new Error("Missing direct-route evaluator");
    return { f, input, state, handler, direct };
  }
  it("captures controls through real MessageService lifetime with distinct incoming and assistant response IDs", async () => {
    const runtime = new AgentRuntime({
      character: { name: "Source lifetime fixture", bio: [] },
      plugins: [
        createAssistantPlugin(),
        {
          name: "source-lifetime-host",
          description: "Isolated native source host",
          responseHandlerEvaluators:
            createElizaPlugin().responseHandlerEvaluators,
          responseHandlerFieldEvaluators: [viewNavigationField],
          actions: [
            {
              ...briefAction,
              validate: async () => true,
              handler: async () => ({
                success: true,
                text: "Brief complete.",
                userFacingText: "Brief complete.",
                verifiedUserFacing: true,
                turnComplete: true,
              }),
            },
          ],
          init: async (_config, active) =>
            registerDirectActionRoutingRule(
              active,
              createTrackedWorkRecapDirectRoutingRule(),
            ),
        },
      ],
      enableAutonomy: false,
      logLevel: "fatal",
    });
    runtime.registerDatabaseAdapter(
      SQLiteDatabaseAdapter.create(":memory:", runtime.agentId),
    );
    cleanup.push(async () => {
      await runtime.stop();
      await runtime.close();
    });
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async () => [1, ...Array(383).fill(0)],
      "source-lifetime-test",
    );
    await runtime.initialize();
    expect(runtime.messageService).toBeInstanceOf(DefaultMessageService);
    const worldId = "66666666-6666-4666-8666-666666666666" as UUID;
    await runtime.createWorld({
      id: worldId,
      name: "Source owner world",
      agentId: runtime.agentId,
      metadata: { ownership: { ownerId: owner }, roles: { [owner]: "OWNER" } },
    });
    await runtime.ensureConnection({
      entityId: owner,
      roomId: room,
      worldId,
      userName: "source-owner",
      name: "source-owner",
      source: "client_chat",
      type: "DM",
    });
    const input = clientMessage();
    input.agentId = runtime.agentId;
    input.content.text = briefRequest;
    let nativeWire = "";
    let responseId: string | undefined;
    runtime.registerModel(
      ModelType.RESPONSE_HANDLER,
      async () => ({
        text: "",
        finishReason: "tool-calls",
        toolCalls: [
          {
            id: "owned-routing",
            name: "HANDLE_RESPONSE",
            arguments: {
              shouldRespond: "RESPOND",
              contexts: ["simple"],
              intents: [],
              candidateActionNames: [],
              contextRequests: [],
              replyText: "",
              replyEffectStatus: "none",
              facts: [],
              relationships: [],
              topics: [],
              addressedTo: [],
              emotion: "none",
              visualContinuation: {
                disposition: "none",
                viewId: "",
                reason: "Domain request",
              },
            },
          },
        ],
      }),
      "source-lifetime-test",
    );
    runtime.registerModel(
      ModelType.ACTION_PLANNER,
      async (_active, params) => {
        const modelParams = params as GenerateTextParams;
        expect(modelParams[MODEL_CANONICAL_CONTEXT]).toBeUndefined();
        nativeWire = JSON.stringify(modelParams.messages);
        expect(nativeWire).toContain(
          "Full controls remain in canonical source",
        );
        expect(nativeWire).not.toContain("HTTP-published Ω value");
        return {
          text: "",
          toolCalls: [
            {
              id: "owned-brief",
              name: "BRIEF",
              arguments: { action: "compose_morning" },
            },
          ],
        };
      },
      "source-lifetime-test",
    );
    // Observe the actual invocation before core intentionally removes runtime-only
    // metadata from provider parameters; delegate to the real model dispatcher.
    const originalUseModel = runtime.useModel.bind(runtime);
    runtime.useModel = (async (
      ...args: Parameters<typeof runtime.useModel>
    ) => {
      if (args[0] === ModelType.ACTION_PLANNER) {
        responseId = getStreamingContext()?.messageId;
        expect(responseId).toBeTruthy();
        expect(responseId).not.toBe(input.id);
        const canonical = (args[1] as GenerateTextParams)[
          MODEL_CANONICAL_CONTEXT
        ];
        expect(canonical?.metadata?.messageId).toBe(input.id);
        expect(canonical?.metadata?.actorId).toBe(owner);
        const source = canonical?.events.find(
          (event) => event.source === "host:active-view",
        ) as ContextProviderEvent;
        expect(source?.text).toContain("HTTP-published Ω value");
      }
      return originalUseModel(...args);
    }) as typeof runtime.useModel;
    installPromptOptimizations(runtime);
    const f = await fixture(1, runtime, async () => {
      const result = await runtime.messageService?.handleMessage(
        runtime,
        input,
        async () => [],
        { onStreamChunk: async () => {} },
      );
      return {
        status: result?.outcome.status,
        response: result?.responseContent?.text,
      };
    });
    const post = async (path: string, body: object) => {
      const result = await fetch(`${f.url}${path}`, {
        method: "POST",
        headers: {
          authorization: "Bearer local-navigation-test",
          "content-type": "application/json",
          "x-eliza-client-id": "origin-client",
        },
        body: JSON.stringify(body),
      });
      expect(result.status).toBe(200);
      return result;
    };
    await post("/api/views/notes/navigate", { source: "user" });
    await post("/api/views/notes/elements", {
      installationId: getView(runtime, "notes")?.installationId,
      elements: [
        {
          id: "lifetime-control",
          role: "textbox",
          label: "Source control",
          value: "HTTP-published Ω value",
        },
      ],
    });
    const result = await post("/api/owned-source-turn", {});
    expect(await result.json()).toMatchObject({
      status: "completed",
      response: "Brief complete.",
    });
    expect(nativeWire).toContain("Full controls remain in canonical source");
    expect(responseId).not.toBe(input.id);
  });
  it.each([
    "current",
    "actor",
    "message",
    "serialized",
    "changed-elements",
    "request",
    "duplicate",
    "copy-deleted-flag",
    "forged-no-markers",
    "client",
    "response",
  ])(
    "captures exact HTTP-reported controls and keeps full originals for %s source binding",
    async (mode) => {
      const x = await staged();
      x.f.runtime.responseHandlerEvaluators.push(activeViewSourceEvaluator);
      const post = async (resource: string, body: object) => {
        const response = await fetch(`${x.f.url}/api/views/notes/${resource}`, {
          method: "POST",
          headers: {
            authorization: "Bearer local-navigation-test",
            "content-type": "application/json",
          },
          body: JSON.stringify({ clientId: "origin-client", ...body }),
        });
        expect(response.status).toBe(200);
      };
      await post("navigate", { source: "user" });
      const installationId = getView(x.f.runtime, "notes")?.installationId;
      await post("elements", {
        installationId,
        elements: [
          {
            id: "literal-control",
            role: "textbox",
            label: "Exact Ω label",
            value: "  original  value  ",
          },
        ],
      });
      await runWithViewClient(
        { hostKey: x.f.hostKey, clientId: "origin-client" },
        () =>
          runWithStreamingContext(
            { messageId: "88888888-8888-4888-8888-888888888888" },
            async () => {
              const run = await runResponseHandlerEvaluators({
                runtime: x.f.runtime,
                message: x.input,
                state: x.state,
                messageHandler: x.handler,
                availableContexts: [],
                userRoles: ["OWNER"],
                evaluators: [x.direct],
              });
              expect(run.errors).toEqual([]);
              const source = run.contextSources?.[0] as ContextProviderEvent;
              expect(source?.text).toContain('"  original  value  "');
              const before = source.text;
              let context: ContextObject = {
                id: "captured",
                metadata: {
                  messageId: x.input.id,
                  roomId: x.input.roomId,
                  actorId: x.input.entityId,
                  providerDiscoveryEnabled: true,
                },
                events: [source],
              };
              if (!context.metadata)
                throw new Error("Missing captured source binding");
              if (mode === "actor") context.metadata.actorId = "other-actor";
              if (mode === "message") context.metadata.messageId = "other-turn";
              if (mode === "serialized")
                context = JSON.parse(JSON.stringify(context));
              if (mode === "request") x.input.content.text += " ";
              if (mode === "duplicate")
                context.events = [...context.events, { ...source }];
              if (mode === "copy-deleted-flag") {
                const copied = { ...source };
                delete copied.discoveryRequiresRuntimeBinding;
                context.events = [copied];
              }
              if (mode === "forged-no-markers") {
                const forged = JSON.parse(
                  JSON.stringify(source),
                ) as ContextProviderEvent;
                delete forged.discoveryRequiresRuntimeBinding;
                forged.text = "Forged collision keeps its full supplied bytes.";
                forged.discoveryText =
                  "Forged notice cannot authorize deferral.";
                context.events = [source, forged];
              }
              if (mode === "changed-elements")
                await post("elements", {
                  installationId,
                  elements: [
                    {
                      id: "new-control",
                      role: "textbox",
                      label: "Later label",
                      value: "new value",
                    },
                  ],
                });
              // These cases inspect source guards; the separate real MessageService
              // regression above qualifies who creates the assistant response ID.
              const inspectBindings = async () => {
                const captured = capturedActiveViewSource(x.f.runtime, context);
                expect(captured?.text).toBe(
                  mode === "current" ? before : undefined,
                );
                expect(Boolean(captured?.deferredText)).toBe(
                  mode === "current",
                );
                const projected = projectDeferredProviders(context);
                expect(projected.available).toEqual(
                  mode === "current" ? ["ACTIVE_VIEW_SNAPSHOT"] : [],
                );
                let plannerWire = "";
                x.f.runtime.character = {
                  name: "Source wire fixture",
                  bio: [],
                };
                Object.assign(x.f.runtime, {
                  useModel: async (
                    _type: string,
                    params: GenerateTextParams,
                  ) => {
                    expect(params[MODEL_CANONICAL_CONTEXT]).toBe(context);
                    expect(JSON.stringify(params)).not.toContain(
                      "modelCanonicalContext",
                    );
                    plannerWire = JSON.stringify(params.messages);
                    return "Complete.";
                  },
                });
                installPromptOptimizations(x.f.runtime as AgentRuntime);
                await runWithTrajectoryContext(
                  { trajectoryStepId: "source-wire-fixture" },
                  () =>
                    x.f.runtime.useModel(ModelType.ACTION_PLANNER, {
                      model: "fixture",
                      [MODEL_CANONICAL_CONTEXT]: context,
                      messages: [
                        {
                          role: "user",
                          content: projected.context.events
                            .filter(
                              (event): event is ContextProviderEvent =>
                                event.type === "provider" && "text" in event,
                            )
                            .map((event) => event.text)
                            .join("\n\n"),
                        },
                      ],
                    }),
                );
                expect(plannerWire.includes("original  value")).toBe(
                  mode !== "current",
                );
                if (mode === "changed-elements")
                  expect(plannerWire).toContain("new value");
                if (mode === "forged-no-markers")
                  expect(plannerWire).toContain(
                    "Forged collision keeps its full supplied bytes.",
                  );
                let evaluatorWire = "";
                await runEvaluator({
                  context,
                  trajectory: {
                    context,
                    modelBaseContext: context,
                    steps: [],
                    archivedSteps: [],
                    plannedQueue: [],
                    evaluatorOutputs: [],
                  },
                  runtime: {
                    useModel: async (_type, params) => {
                      evaluatorWire = JSON.stringify(params.messages);
                      return JSON.stringify({
                        decision: "CONTINUE",
                        success: false,
                        thought: "Source wire inspection",
                      });
                    },
                  },
                });
                expect(evaluatorWire.includes("original  value")).toBe(
                  mode !== "current",
                );
                if (mode === "forged-no-markers")
                  expect(evaluatorWire).toContain(
                    "Forged collision keeps its full supplied bytes.",
                  );
                expect(source.text).toBe(before);
                expect(x.handler.plan).not.toHaveProperty("wholeRequestOwner");
              };
              if (mode === "client")
                await runWithViewClient(
                  { hostKey: x.f.hostKey, clientId: "other-client" },
                  inspectBindings,
                );
              else if (mode === "response")
                await runWithStreamingContext(
                  { messageId: "other-assistant-response" },
                  inspectBindings,
                );
              else await inspectBindings();
            },
          ),
      );
    },
  );
  it("replays capture480 through the actual staged host field and all three evaluators", async () => {
    const x = await staged();
    const original = structuredClone(x.input);
    const run = await runResponseHandlerEvaluators({
      runtime: x.f.runtime,
      message: x.input,
      state: x.state,
      messageHandler: x.handler,
      availableContexts: [],
      userRoles: ["OWNER"],
      evaluators: [x.direct, calendarReadBindingEvaluator],
    });
    expect(run.errors).toEqual([]);
    expect(x.handler.plan.intents).toEqual([briefRequest]);
    expect(x.handler.plan.contexts).toEqual(["productivity", "tasks"]);
    expect(x.handler.plan.candidateActions).toEqual(["BRIEF"]);
    expect(x.handler.plan.calendarReadBindings).toBeUndefined();
    expect(x.handler.plan.contextSlices).toEqual([
      "Existing authorized source context",
    ]);
    expect(x.handler.plan).not.toHaveProperty("invalidatedScopeFields");
    expect(x.input).toEqual(original);
    expect(x.f.requests()).toBe(0);
    expect(x.f.frames).toHaveLength(0);
  });
  it.each(["; open Notes", "\nOpen Notes", " and open Notes"])(
    "preserves explicit compound navigation: %s",
    async (tail) => {
      const x = await staged(`Give me my daily dossier${tail}`, {
        disposition: "planning",
        viewId: "notes",
        reason: "Explicit independent navigation",
      });
      x.handler.plan.intents = ["Give me my daily dossier", "Open Notes"];
      delete x.handler.plan.calendarReadBindings;
      await runResponseHandlerEvaluators({
        runtime: x.f.runtime,
        message: x.input,
        state: x.state,
        messageHandler: x.handler,
        availableContexts: [],
        userRoles: ["OWNER"],
        evaluators: [x.direct],
      });
      expect(x.handler.plan.intents).toEqual([
        "Give me my daily dossier",
        "Open Notes",
      ]);
      expect(x.handler.plan.candidateActions).toContain("VIEWS");
      expect(
        x.handler.plan.contextSlices?.some((slice) =>
          slice.includes("Current-request navigation judgment"),
        ),
      ).toBe(true);
      expect(await show(x.f.runtime, "Notes", x.input)).toMatchObject({
        success: true,
      });
      expect(x.f.frames).toHaveLength(1);
    },
  );
  it("does not accept a forged model or plan invalidation marker", async () => {
    const x = await staged(
      "Open Notes",
      {
        disposition: "planning",
        viewId: "notes",
        reason: "Explicit navigation",
      },
      false,
    );
    x.handler.plan.invalidatedScopeFields = ["visualContinuation"];
    x.handler.plan.intents = ["Open Notes"];
    delete x.handler.plan.calendarReadBindings;
    await runResponseHandlerEvaluators({
      runtime: x.f.runtime,
      message: x.input,
      state: x.state,
      messageHandler: x.handler,
      availableContexts: [],
      userRoles: ["OWNER"],
    });
    expect(x.handler.plan.candidateActions).toContain("VIEWS");
    expect(await show(x.f.runtime, "Notes", x.input)).toMatchObject({
      success: true,
    });
    expect(x.f.frames).toHaveLength(1);
  });
  it.each(["none", "forbidden"])(
    "preserves the staged %s navigation denial after scope replacement",
    async (disposition) => {
      const x = await staged(briefRequest, {
        disposition,
        viewId: "Home",
        reason: "No navigation permitted",
      });
      await runWithStreamingContext(
        { messageId: String(x.input.id), onStreamChunk: () => {} },
        async () => {
          await runResponseHandlerEvaluators({
            runtime: x.f.runtime,
            message: x.input,
            state: x.state,
            messageHandler: x.handler,
            availableContexts: [],
            userRoles: ["OWNER"],
            evaluators: [x.direct],
          });
          expect(x.handler.plan.candidateActions).toEqual(["BRIEF"]);
          expect(await show(x.f.runtime, "Notes", x.input)).toMatchObject({
            success: false,
          });
          expect(x.f.frames).toHaveLength(0);
        },
      );
    },
  );
});

describe("native completed-action navigation", () => {
  it("retires an unclaimed prepared navigation with its owning host", async () => {
    const f = await fixture(0, undefined, undefined, true);
    vi.stubEnv("ELIZA_LOCAL_AGENT_TRANSPORT", "filesystem-v1");
    const input = clientMessage();
    input.content.metadata = {
      viewClientId: "origin-client",
      viewDelivery: "completed-action",
    };
    await selectNavigation(f, input);
    const result = await show(f.runtime, "notes", input);
    if (!result || typeof result === "boolean" || !result.values)
      throw Error("Missing prepared result");
    closeViewInteractionHost(f.hostKey);
    const response = await fetch(f.url + "/api/views/interact-claim", {
      method: "POST",
      headers: {
        authorization: "Bearer local-navigation-test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(result.values.navigationBinding),
    });
    expect(response.ok).toBe(false);
    expect(
      getCurrentViewState(f.runtime, {
        hostKey: f.hostKey,
        clientId: "origin-client",
      }),
    ).toBeNull();
    expect(f.frames).toHaveLength(0);
  });

  it("prepares through the registered kernel and commits only an exact owner/renderer claim and switch result", async () => {
    const f = await fixture(0, undefined, undefined, true);
    vi.stubEnv("ELIZA_LOCAL_AGENT_TRANSPORT", "filesystem-v1");
    const input = clientMessage();
    input.content.metadata = {
      viewClientId: "origin-client",
      viewDelivery: "completed-action",
      uiView: "chat",
    };
    await selectNavigation(f, input);
    const result = await show(f.runtime, "notes", input);
    expect(result).toMatchObject({
      success: true,
      verifiedUserFacing: true,
      data: { navigation: { status: "prepared" } },
      values: { navigationPrepared: true, completedActionDelivered: false },
    });
    expect(
      result && typeof result !== "boolean" && result.userFacingText,
    ).not.toContain("Opened");
    expect(f.kernelRequests()).toBe(1);
    expect(f.frames).toHaveLength(0);
    const scope = { hostKey: f.hostKey, clientId: "origin-client" };
    expect(getCurrentViewState(f.runtime, scope)).toBeNull();
    if (
      !result ||
      typeof result === "boolean" ||
      !result.values ||
      !isObjectRecord(result.values.navigationBinding)
    )
      throw Error("Missing prepared binding");
    const binding = result.values.navigationBinding;
    const post = (
      path: string,
      body: unknown,
      authorization = "Bearer local-navigation-test",
    ) =>
      fetch(f.url + path, {
        method: "POST",
        headers: { authorization, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(
      (
        await post(
          "/api/views/interact-claim",
          binding,
          "Bearer other-navigation-owner",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post("/api/views/interact-claim", {
          ...binding,
          clientId: "other-client",
        })
      ).status,
    ).toBe(409);
    const claimed = await post("/api/views/interact-claim", binding);
    expect(claimed.status).toBe(200);
    const { claimId } = await claimed.json();
    const settled = {
      ...binding,
      claimId,
      success: true,
      result: { switched: true },
    };
    expect(
      await (
        await post("/api/views/interact-result", {
          ...settled,
          claimId: "wrong",
        })
      ).json(),
    ).toMatchObject({ accepted: false });
    expect(
      await (
        await post(
          "/api/views/interact-result",
          settled,
          "Bearer other-navigation-owner",
        )
      ).json(),
    ).toMatchObject({ accepted: false });
    expect(
      await (
        await post("/api/views/interact-result", {
          ...settled,
          result: { switched: true, personalText: "not authorized" },
        })
      ).json(),
    ).toMatchObject({ accepted: false });
    expect(getCurrentViewState(f.runtime, scope)).toBeNull();
    expect(
      await (await post("/api/views/interact-result", settled)).json(),
    ).toMatchObject({ accepted: true });
    await vi.waitFor(() =>
      expect(getCurrentViewState(f.runtime, scope)?.viewId).toBe("notes"),
    );
    expect(
      await (await post("/api/views/interact-result", settled)).json(),
    ).toMatchObject({ accepted: false });
    expect(f.frames).toHaveLength(0);
  });
  it.each([
    { disposition: "planning", plan: {}, stale: false },
    {
      disposition: "direct",
      plan: { intents: ["Open Notes", "Read a personal record"] },
      stale: false,
    },
    { disposition: "direct", plan: {}, stale: true },
  ])(
    "does not turn conditional/compound/stale metadata into a direct handoff: %j",
    async ({ disposition, plan, stale }) => {
      const f = await fixture(0, undefined, undefined, true);
      const input = clientMessage();
      input.content.metadata = {
        viewClientId: "origin-client",
        viewDelivery: "completed-action",
      };
      await selectNavigation(f, input, { disposition }, plan);
      if (stale) input.content.metadata.viewClientId = "rotated-client";
      expect(await show(f.runtime, "notes", input)).toMatchObject({
        success: false,
      });
      expect(f.requests()).toBe(0);
      expect(f.frames).toHaveLength(0);
    },
  );
});
