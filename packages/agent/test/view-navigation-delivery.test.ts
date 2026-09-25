/** Real loopback HTTP and registered-view delivery, with actor roles and renderer targets isolated. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Action,
  ContextRegistry,
  type GenerateTextResult,
  type IAgentRuntime,
  isObjectRecord,
  type Memory,
  type MessageHandlerResult,
  ModelType,
  ResponseHandlerFieldRegistry,
  runResponseHandlerEvaluators,
  runWithStreamingContext,
  type UUID,
} from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uiContextProvider } from "../../../plugins/plugin-assistant/src/features/basic-capabilities/providers/uiContext.ts";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../../plugins/plugin-assistant/src/runtime/builtin-field-evaluators.ts";
import { runPlannerLoop } from "../../../plugins/plugin-assistant/src/runtime/planner-loop.ts";
import { collectV5PlannerCandidateActions } from "../../../plugins/plugin-assistant/src/services/message/action-surface.ts";
import { runV5MessageRuntimeStage1 } from "../../../plugins/plugin-assistant/src/services/message/pipeline.ts";
import { createPlannerToolDiscoveryAction } from "../../../plugins/plugin-assistant/src/services/message/tool-discovery.ts";
import { viewsAction } from "../src/actions/views.ts";
import {
  closeRuntimeViewRegistry,
  registerBuiltinViews,
  registerPluginViews,
} from "../src/api/views-registry.ts";
import { handleViewsRoutes } from "../src/api/views-routes.ts";
import { createElizaPlugin } from "../src/runtime/eliza-plugin.ts";
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
async function fixture(delivered = 1) {
  const frames: Array<{ client: string; frame: object }> = [];
  let requests = 0;
  const runtime = {
    agentId: "44444444-4444-4444-8444-444444444444",
    actions: [viewsAction],
    responseHandlerEvaluators: [viewNavigationEvaluator],
    getRoom: async () => ({ worldId: "world" }),
    getWorld: async () => ({
      id: "world",
      metadata: { roles: { [owner]: "OWNER" }, ownership: { ownerId: owner } },
    }),
    getSetting: () => undefined,
    getEntityById: async () => null,
    emitEvent: async () => undefined,
    reportError: vi.fn(),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as IAgentRuntime;
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
  const server = createServer((req, res) => {
    requests++;
    if (req.headers.authorization !== "Bearer local-navigation-test") {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleViewsRoutes({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      hostKey,
      runtime,
      callerAuthorization: { ok: true, role: "OWNER", identityId: owner },
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
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("ELIZA_API_PORT", String((server.address() as AddressInfo).port));
  vi.stubEnv("ELIZA_API_TOKEN", "local-navigation-test");
  cleanup.push(async () => {
    closeRuntimeViewRegistry(runtime);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { runtime, frames, requests: () => requests };
}
async function show(runtime: IAgentRuntime, view: string, input = message) {
  return viewsAction.handler?.(runtime, input, undefined, {
    parameters: { action: "show", view },
  });
}
describe("host view navigation", () => {
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
        disposition: "requested",
        viewId: "notes",
        singleViewOnly: true,
        navigationOnly: true,
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
  it.each(["compound", "conditional", "unknown"])(
    "keeps %s navigation and domain work in the planner",
    async (mode) => {
      const f = await fixture();
      const selected = await selectNavigation(
        f,
        clientMessage(),
        {
          navigationOnly: false,
          ...(mode === "unknown" ? { viewId: "unregistered" } : {}),
        },
        {
          intents: ["Read notes", "Open Notes"],
          candidateActions: ["NOTES_LIST"],
        },
      );
      expect(selected.plan.deterministicToolCall).toBeUndefined();
      expect(selected.plan.candidateActions).toEqual(["NOTES_LIST", "VIEWS"]);
      expect(selected.plan.intents).toEqual(["Read notes", "Open Notes"]);
      expect(f.requests()).toBe(0);
    },
  );
  it.each(["forbidden", "none", "unresolved", "optional"])(
    "does not directly execute %s",
    async (disposition) => {
      const f = await fixture();
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
  it("rechecks owner role and rejects cancellation after the model decision", async () => {
    const f = await fixture();
    const input = clientMessage();
    const roleChanged = await selectNavigation(
      f,
      input,
      { viewId: "chat" },
      {},
      () => {
        f.runtime.getWorld = async () =>
          ({ id: "world", metadata: { roles: { [owner]: "USER" } } }) as never;
      },
    );
    expect(roleChanged.plan.deterministicToolCall).toBeUndefined();
    const other = await fixture();
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
          { viewId: "chat" },
          {},
          () => controller.abort(),
        );
        expect(selected.plan.deterministicToolCall).toBeUndefined();
      },
    );
    expect(f.requests() + other.requests()).toBe(0);
  });
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
  it("ignores missing, malformed and client-metadata decisions", async () => {
    const f = await fixture();
    for (const disposition of ["invalid", null]) {
      const input = clientMessage();
      input.content.metadata = {
        viewClientId: "origin-client",
        visualContinuation: {
          disposition: "requested",
          viewId: "chat",
          navigationOnly: true,
          singleViewOnly: true,
        },
      };
      const selected = await selectNavigation(f, input, {
        disposition,
        viewId: "chat",
      });
      expect(selected.plan.deterministicToolCall).toBeUndefined();
    }
    expect(f.requests()).toBe(0);
  });
  it.each([false, true])(
    "runs the canonical pipeline and gates the held reply (wrong destination=%s)",
    async (wrongDestination) => {
      const f = await fixture();
      const input = clientMessage();
      input.content.text = "Open Home";
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
                candidateActionNames: ["VIEWS"],
                replyText: wrongDestination
                  ? "Calendar is open."
                  : "Chat is open.",
                replyEffectStatus: "pending",
                facts: [],
                relationships: [],
                topics: [],
                addressedTo: [],
                emotion: "none",
                visualContinuation: {
                  disposition: "requested",
                  viewId: "chat",
                  singleViewOnly: true,
                  navigationOnly: true,
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
        await expect(resultPromise).rejects.toBe(recoveryRequired);
      } else {
        const result = await resultPromise;
        expect(useModel).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
          kind: "planned_reply",
          result: { responseContent: { text: "Chat is open." } },
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
                singleViewOnly: false,
                navigationOnly: false,
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
