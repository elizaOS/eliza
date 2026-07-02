import {
  registerPluginViews,
  unregisterPluginViews,
} from "@elizaos/agent/api/views-registry";
import {
  handleViewsRoutes,
  type ViewsRouteContext,
} from "@elizaos/agent/api/views-routes";
import { installPromptOptimizations } from "@elizaos/agent/runtime/prompt-optimization";
import {
  clearActiveViewContext,
  setActiveViewContext,
  setActiveViewElements,
} from "@elizaos/agent/runtime/view-action-affinity";
import type {
  IAgentRuntime,
  Plugin,
  Route,
  RouteRequest,
  RouteResponse,
  ViewDeclaration,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { stage1ResponseHandlerFixture } from "@elizaos/test-harness/action-route-fixtures";
import type { LlmProxyCall } from "@elizaos/test-harness/llm-proxy";
import {
  matchesScenarioInput,
  type RuntimeWithScenarioLlmFixtures,
} from "./_helpers/strict-llm-action-fixtures";

const VIEW_ID = "scenario-active-ledger";
const VIEW_LABEL = "Scenario Active Ledger";
const FILL_TEXT = "Fill the focused ledger title with Close Issue 11355";
const CLICK_TEXT = "Click the save button in the active ledger view";

type ScenarioState = {
  savedCount: number;
  title: string;
  interactions: Array<{
    capability: string;
    params: Record<string, unknown>;
    resultingTitle: string;
    savedCount: number;
  }>;
  broadcasts: unknown[];
};

const state: ScenarioState = {
  savedCount: 0,
  title: "Untitled Ledger",
  interactions: [],
  broadcasts: [],
};

let restoreFetch: (() => void) | null = null;

const activeLedgerView: ViewDeclaration = {
  id: VIEW_ID,
  label: VIEW_LABEL,
  description: "Scenario view that exposes agent-addressable ledger controls.",
  icon: "PanelTopOpen",
  path: "/scenario/active-ledger",
  tags: ["scenario", "active-view", "ledger"],
  viewType: "gui",
  serverInteract: async (capability, params = {}) => {
    if (capability === "agent-fill") {
      const value = typeof params.value === "string" ? params.value : "";
      if (params.id !== "ledger-title" || value.length === 0) {
        throw new Error(
          `expected agent-fill on ledger-title with value, saw ${JSON.stringify(
            params,
          )}`,
        );
      }
      state.title = value;
    } else if (capability === "agent-click") {
      if (params.id !== "save-ledger") {
        throw new Error(
          `expected agent-click on save-ledger, saw ${JSON.stringify(params)}`,
        );
      }
      state.savedCount += 1;
    } else {
      throw new Error(`unexpected capability ${capability}`);
    }

    const entry = {
      capability,
      params,
      resultingTitle: state.title,
      savedCount: state.savedCount,
    };
    state.interactions.push(entry);
    return { success: true, ...entry };
  },
};

const viewRoutes = [
  { type: "GET", path: "/api/views" },
  { type: "GET", path: "/api/views/current" },
  { type: "POST", path: `/api/views/${VIEW_ID}/navigate` },
  { type: "POST", path: `/api/views/${VIEW_ID}/elements` },
  { type: "POST", path: `/api/views/${VIEW_ID}/interact` },
] as const;

function toViewsRouteContext(
  req: RouteRequest,
  res: RouteResponse,
  runtime: IAgentRuntime,
): ViewsRouteContext {
  const url = new URL(req.url ?? req.path ?? "/", "http://127.0.0.1");
  return {
    req: req as never,
    res: res as never,
    runtime,
    pathname: url.pathname,
    method: (req.method ?? "GET").toUpperCase(),
    url,
    broadcastWs: (payload) => {
      state.broadcasts.push(payload);
    },
    json: (response, data, status = 200) => {
      response.status(status).json(data);
    },
    error: (response, message, status = 400) => {
      response.status(status).json({ error: message });
    },
  };
}

const scenarioViewsRoutePlugin: Plugin = {
  name: "scenario-active-view-routes",
  description: "Scenario-only wrappers for the agent view routes.",
  routes: viewRoutes.map(
    (route): Route => ({
      ...route,
      rawPath: true,
      handler: async (req, res, runtime) => {
        await handleViewsRoutes(toViewsRouteContext(req, res, runtime));
      },
    }),
  ),
};

type RuntimeWithScenarioPlugins = RuntimeWithScenarioLlmFixtures & {
  plugins?: Array<{ name?: string }>;
  registerPlugin?: (plugin: Plugin) => Promise<void>;
};

function actionParams(
  execution: ScenarioTurnExecution,
): Record<string, unknown> | null {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "VIEWS",
  );
  if (!action?.parameters || typeof action.parameters !== "object") {
    return null;
  }
  const envelope = action.parameters as Record<string, unknown>;
  return envelope.parameters &&
    typeof envelope.parameters === "object" &&
    !Array.isArray(envelope.parameters)
    ? (envelope.parameters as Record<string, unknown>)
    : envelope;
}

function expectViewsInteract(
  execution: ScenarioTurnExecution,
  expected: {
    capability: string;
    elementId: string;
    responseText: string;
    value?: string;
  },
): string | undefined {
  if (execution.responseText !== expected.responseText) {
    return `expected responseText=${JSON.stringify(expected.responseText)}, saw ${JSON.stringify(execution.responseText)}`;
  }
  const params = actionParams(execution);
  if (!params) return "expected VIEWS action parameters";
  if (params.action !== "interact") {
    return `expected action=interact, saw ${String(params.action)}`;
  }
  if (params.view !== VIEW_ID) {
    return `expected view=${VIEW_ID}, saw ${String(params.view)}`;
  }
  if (params.capability !== expected.capability) {
    return `expected capability=${expected.capability}, saw ${String(params.capability)}`;
  }
  const nested =
    params.params &&
    typeof params.params === "object" &&
    !Array.isArray(params.params)
      ? (params.params as Record<string, unknown>)
      : {};
  if (nested.id !== expected.elementId) {
    return `expected params.id=${expected.elementId}, saw ${String(nested.id)}`;
  }
  if (expected.value !== undefined && nested.value !== expected.value) {
    return `expected params.value=${expected.value}, saw ${String(nested.value)}`;
  }
  return undefined;
}

function promptHasActiveViewElements(value: string): boolean {
  return [
    "# Active View",
    VIEW_LABEL,
    VIEW_ID,
    "Addressable elements currently in this view",
    "ledger-title [textbox]",
    "save-ledger [button]",
    "agent-fill {id,value}",
    "agent-click {id}",
  ].every((needle) => value.includes(needle));
}

function plannerFixture({
  capability,
  elementId,
  input,
  messageToUser,
  value,
}: {
  capability: "agent-click" | "agent-fill";
  elementId: string;
  input: string;
  messageToUser: string;
  value?: string;
}) {
  return {
    name: `active-view-planner-${capability}-${elementId}`,
    match: (call: LlmProxyCall) =>
      call.modelType === ModelType.ACTION_PLANNER &&
      matchesScenarioInput(input)(call.latestUserText) &&
      call.toolNames.includes("VIEWS") &&
      promptHasActiveViewElements(
        `${call.params.prompt ?? ""}\n${call.latestUserText}`,
      ),
    response: {
      text: "",
      thought: `Use the active-view element id ${elementId}.`,
      messageToUser,
      completed: true,
      finishReason: "tool-calls",
      toolCalls: [
        {
          id: `call-${capability}-${elementId}`,
          name: "VIEWS",
          type: "function",
          arguments: {
            action: "interact",
            capability,
            params: {
              id: elementId,
              ...(value ? { value } : {}),
            },
            view: VIEW_ID,
            viewType: "gui",
          },
        },
      ],
    },
    times: 1,
  };
}

function installScenarioInteractFetchShim(): void {
  restoreFetch?.();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlText =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(urlText);
    if (
      url.hostname === "127.0.0.1" &&
      url.pathname === `/api/views/${VIEW_ID}/interact`
    ) {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      const capability =
        typeof body.capability === "string" ? body.capability : "";
      const params =
        body.params && typeof body.params === "object"
          ? (body.params as Record<string, unknown>)
          : {};
      const result = await activeLedgerView.serverInteract?.(
        capability,
        params,
      );
      return new Response(
        JSON.stringify({
          success: true,
          text:
            capability === "agent-fill"
              ? "Filled the active ledger title."
              : "Saved the active ledger.",
          result,
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 200,
        },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = originalFetch;
    restoreFetch = null;
  };
}

export default scenario({
  id: "deterministic-active-view-agent-surface",
  lane: "pr-deterministic",
  title: "Deterministic active-view agent-surface trajectory",
  domain: "scenario-runner",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "app-control",
    "views",
    "active-view",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-app-control", "scenario-active-view-routes"],
  },
  seed: [
    {
      type: "custom",
      name: "register active-view route wrapper, view, and strict planner fixtures",
      apply: async (ctx) => {
        state.savedCount = 0;
        state.title = "Untitled Ledger";
        state.interactions.length = 0;
        state.broadcasts.length = 0;
        clearActiveViewContext();
        installScenarioInteractFetchShim();
        unregisterPluginViews(scenarioViewsRoutePlugin.name);
        await registerPluginViews(scenarioViewsRoutePlugin, [activeLedgerView]);

        const runtime = ctx.runtime as RuntimeWithScenarioPlugins;
        if (!runtime?.registerPlugin) {
          return "runtime.registerPlugin unavailable";
        }
        if (
          !runtime.plugins?.some(
            (plugin) => plugin.name === scenarioViewsRoutePlugin.name,
          )
        ) {
          await runtime.registerPlugin(scenarioViewsRoutePlugin);
        }
        installPromptOptimizations(runtime as never, {} as never);
        runtime.scenarioLlmFixtures?.register(
          stage1ResponseHandlerFixture({
            actionName: "VIEWS",
            contextIds: ["active-view", "views"],
            input: FILL_TEXT,
            messageToUser: "Filling the active ledger title.",
            args: {
              action: "interact",
              capability: "agent-fill",
              params: { id: "ledger-title", value: "Close Issue 11355" },
              view: VIEW_ID,
              viewType: "gui",
            },
          }),
          plannerFixture({
            capability: "agent-fill",
            elementId: "ledger-title",
            input: FILL_TEXT,
            messageToUser: "Filled the active ledger title.",
            value: "Close Issue 11355",
          }),
          stage1ResponseHandlerFixture({
            actionName: "VIEWS",
            contextIds: ["active-view", "views"],
            input: CLICK_TEXT,
            messageToUser: "Saving the active ledger.",
            args: {
              action: "interact",
              capability: "agent-click",
              params: { id: "save-ledger" },
              view: VIEW_ID,
              viewType: "gui",
            },
          }),
          plannerFixture({
            capability: "agent-click",
            elementId: "save-ledger",
            input: CLICK_TEXT,
            messageToUser: "Saved the active ledger.",
          }),
        );
        return undefined;
      },
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "restore scenario active-view fetch shim",
      apply: () => {
        restoreFetch?.();
        clearActiveViewContext();
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "client_chat",
      title: "Active View Agent Surface",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "shell navigates to active ledger",
      method: "POST",
      path: `/api/views/${VIEW_ID}/navigate`,
      body: { source: "user", viewType: "gui" },
      expectedStatus: 200,
      assertResponse: (_status, body) => {
        const response = body as { ok?: unknown; viewId?: unknown };
        if (response.ok !== true || response.viewId !== VIEW_ID) {
          return `expected active ledger navigate response, saw ${JSON.stringify(body)}`;
        }
        setActiveViewContext({
          viewId: VIEW_ID,
          viewLabel: VIEW_LABEL,
          viewPath: "/scenario/active-ledger",
          viewType: "gui",
          source: "user",
          switchedAt: new Date().toISOString(),
        });
        return undefined;
      },
    },
    {
      kind: "api",
      name: "shell reports active ledger elements",
      method: "POST",
      path: `/api/views/${VIEW_ID}/elements`,
      body: {
        elements: [
          {
            id: "ledger-title",
            role: "textbox",
            label: "Ledger title",
            value: "Untitled Ledger",
            focused: true,
          },
          {
            id: "save-ledger",
            role: "button",
            label: "Save ledger",
          },
        ],
      },
      expectedStatus: 200,
      assertResponse: (_status, body) => {
        const response = body as {
          accepted?: unknown;
          count?: unknown;
          viewId?: unknown;
        };
        if (
          response.accepted !== true ||
          response.count !== 2 ||
          response.viewId !== VIEW_ID
        ) {
          return `expected accepted element report, saw ${JSON.stringify(body)}`;
        }
        const accepted = setActiveViewElements(VIEW_ID, [
          {
            id: "ledger-title",
            role: "textbox",
            label: "Ledger title",
            value: "Untitled Ledger",
            focused: true,
          },
          {
            id: "save-ledger",
            role: "button",
            label: "Save ledger",
          },
        ]);
        return accepted
          ? undefined
          : "expected active-view element snapshot to attach to prompt optimizer context";
      },
    },
    {
      kind: "message",
      name: "planner fills active-view element by id",
      text: FILL_TEXT,
      expectedActions: ["VIEWS"],
      responseIncludesAny: ["Filled the active ledger title."],
      assertTurn: (execution) =>
        expectViewsInteract(execution, {
          capability: "agent-fill",
          elementId: "ledger-title",
          responseText: "Filled the active ledger title.",
          value: "Close Issue 11355",
        }),
    },
    {
      kind: "message",
      name: "planner clicks active-view element by id",
      text: CLICK_TEXT,
      expectedActions: ["VIEWS"],
      responseIncludesAny: ["Saved the active ledger."],
      assertTurn: (execution) =>
        expectViewsInteract(execution, {
          capability: "agent-click",
          elementId: "save-ledger",
          responseText: "Saved the active ledger.",
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "VIEWS",
      status: "success",
      minCount: 2,
    },
    {
      type: "selectedActionArguments",
      actionName: "VIEWS",
      includesAll: [
        /"action":"interact"/,
        /"view":"scenario-active-ledger"/,
        /"capability":"agent-fill"/,
        /"id":"ledger-title"/,
        /"value":"Close Issue 11355"/,
        /"capability":"agent-click"/,
        /"id":"save-ledger"/,
      ],
    },
    {
      type: "custom",
      name: "serverInteract saw fill then click domain effects",
      predicate: () => {
        const expected = [
          {
            capability: "agent-fill",
            params: { id: "ledger-title", value: "Close Issue 11355" },
            resultingTitle: "Close Issue 11355",
            savedCount: 0,
          },
          {
            capability: "agent-click",
            params: { id: "save-ledger" },
            resultingTitle: "Close Issue 11355",
            savedCount: 1,
          },
        ];
        return JSON.stringify(state.interactions) === JSON.stringify(expected)
          ? undefined
          : `expected exact serverInteract ledger ${JSON.stringify(expected)}, saw ${JSON.stringify(state.interactions)}`;
      },
    },
  ],
});
