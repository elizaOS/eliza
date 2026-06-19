import { ModelType } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  jsonResponse,
  readAppControlHttpRequests,
  registerAppControlHttpHandler,
  resetAppControlHttpLoopback,
} from "./_helpers/app-control-http-loopback";
import { matchesScenarioInput } from "./_helpers/strict-llm-action-fixtures";

type RuntimeWithScenarioLlmFixtures = {
  scenarioLlmFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
};

const views = [
  {
    id: "__view-manager__",
    label: "View Manager",
    viewType: "gui",
    description: "Manage available local views.",
    path: "/views",
    pluginName: "@elizaos/plugin-app-control",
    available: true,
    tags: ["views", "manager"],
  },
  {
    id: "remote-ledger",
    label: "Remote Ledger",
    viewType: "gui",
    description: "Track finance balances and remote ledger entries.",
    path: "/remote-ledger",
    pluginName: "@elizaos/plugin-remote-ledger",
    available: true,
    tags: ["finance", "ledger"],
    capabilities: [
      {
        name: "fill-input",
        description: "Fill a named input in the view.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string" },
          },
          required: ["name", "value"],
        },
      },
    ],
  },
];

function readParameters(action: CapturedAction): Record<string, unknown> {
  return action.parameters &&
    typeof action.parameters === "object" &&
    !Array.isArray(action.parameters)
    ? (action.parameters as Record<string, unknown>)
    : {};
}

function expectViewsAction(
  execution: ScenarioTurnExecution,
  expected: {
    action: string;
    alwaysOnTop?: boolean;
    capability?: string;
    responseText?: string;
    view?: string;
    paramValue?: string;
  },
): string | undefined {
  if (
    expected.responseText !== undefined &&
    execution.responseText !== expected.responseText
  ) {
    return `expected responseText=${JSON.stringify(expected.responseText)}, saw ${JSON.stringify(execution.responseText)}`;
  }
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "VIEWS",
  );
  if (!action) {
    return `expected VIEWS action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }
  const params = readParameters(action);
  if (params.action !== expected.action && params.mode !== expected.action) {
    return `expected VIEWS action=${expected.action}, saw ${String(params.action ?? params.mode)}`;
  }
  if (
    expected.view &&
    params.view !== expected.view &&
    params.id !== expected.view
  ) {
    return `expected VIEWS view=${expected.view}, saw ${String(params.view ?? params.id)}`;
  }
  if (expected.capability && params.capability !== expected.capability) {
    return `expected VIEWS capability=${expected.capability}, saw ${String(params.capability)}`;
  }
  if (
    expected.alwaysOnTop !== undefined &&
    params.alwaysOnTop !== expected.alwaysOnTop
  ) {
    return `expected VIEWS alwaysOnTop=${expected.alwaysOnTop}, saw ${String(params.alwaysOnTop)}`;
  }
  if (expected.paramValue) {
    const capabilityParams =
      params.params &&
      typeof params.params === "object" &&
      !Array.isArray(params.params)
        ? (params.params as Record<string, unknown>)
        : {};
    if (capabilityParams.value !== expected.paramValue) {
      return `expected VIEWS params.value=${expected.paramValue}, saw ${String(capabilityParams.value)}`;
    }
  }
  return undefined;
}

export default scenario({
  id: "deterministic-pr-smoke",
  title: "Deterministic PR scenario smoke",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  seed: [
    {
      type: "custom",
      name: "local view loopback API for deterministic shell actions",
      apply: (ctx) => {
        resetAppControlHttpLoopback();
        const runtime = ctx.runtime as RuntimeWithScenarioLlmFixtures;
        runtime.scenarioLlmFixtures?.register({
          name: "pr-smoke-deterministic-reply",
          match: {
            modelType: ModelType.RESPONSE_HANDLER,
            input: matchesScenarioInput("hello deterministic proxy"),
            toolName: "HANDLE_RESPONSE",
          },
          response: {
            shouldRespond: "RESPOND",
            contexts: ["simple"],
            intents: ["hello deterministic proxy"],
            replyText: "deterministic-test-response: hello deterministic proxy",
            candidateActionNames: [],
            facts: [],
            relationships: [],
            addressedTo: [],
            emotion: "none",
          },
          times: 1,
        });
        registerAppControlHttpHandler((request) => {
          if (!request.pathname.startsWith("/api/views")) return undefined;
          if (request.method === "GET" && request.pathname === "/api/views") {
            return jsonResponse({ views });
          }
          if (request.pathname.endsWith("/interact")) {
            return jsonResponse({
              ok: true,
              capability: "fill-input",
              value: "Remote Ledger Updated",
            });
          }
          return jsonResponse({ ok: true });
        });
        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Deterministic PR Smoke",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "deterministic reply",
      text: "hello deterministic proxy",
      responseIncludesAny: [
        "deterministic-test-response: hello deterministic proxy",
      ],
      assertTurn: (execution) =>
        execution.responseText ===
        "deterministic-test-response: hello deterministic proxy"
          ? undefined
          : `expected exact deterministic reply, saw ${JSON.stringify(execution.responseText)}`,
    },
    {
      kind: "action",
      name: "open view manager",
      text: "Open the view manager",
      actionName: "VIEWS",
      options: { action: "manager" },
      responseIncludesAny: [
        "View Manager",
        "Opened View Manager",
        "Navigated to View Manager",
      ],
      assertTurn: (execution) =>
        expectViewsAction(execution, {
          action: "manager",
          responseText: "Navigated to View Manager.",
        }),
    },
    {
      kind: "action",
      name: "pin remote ledger",
      text: "Pin the remote ledger view as a desktop tab",
      actionName: "VIEWS",
      options: { action: "pin", view: "remote-ledger" },
      responseIncludesAny: ["Pinned", "Requested desktop tab pin"],
      assertTurn: (execution) =>
        expectViewsAction(execution, {
          action: "pin",
          responseText: 'Pinned gui view "remote-ledger" as a desktop tab.',
          view: "remote-ledger",
        }),
    },
    {
      kind: "action",
      name: "open remote ledger window",
      text: "Open the remote ledger view in a separate always on top window",
      actionName: "VIEWS",
      options: { action: "window", alwaysOnTop: true, view: "remote-ledger" },
      responseIncludesAny: ["separate window", "Requested separate window"],
      assertTurn: (execution) =>
        expectViewsAction(execution, {
          action: "window",
          alwaysOnTop: true,
          responseText: 'Opened gui view "remote-ledger" in a separate window.',
          view: "remote-ledger",
        }),
    },
    {
      kind: "action",
      name: "fill remote ledger title",
      text: "Fill the remote ledger view title input with Remote Ledger Updated",
      actionName: "VIEWS",
      options: {
        action: "interact",
        capability: "fill-input",
        params: { name: "view-title", value: "Remote Ledger Updated" },
        view: "remote-ledger",
      },
      responseIncludesAny: [
        "remote-ledger",
        "Interacted with view",
        "Remote Ledger Updated",
      ],
      assertTurn: (execution) =>
        expectViewsAction(execution, {
          action: "interact",
          capability: "fill-input",
          paramValue: "Remote Ledger Updated",
          responseText:
            'Interacted with view "remote-ledger" — capability "fill-input" (returned ok, capability, value).',
          view: "remote-ledger",
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "VIEWS",
      minCount: 4,
    },
    {
      type: "selectedActionArguments",
      actionName: "VIEWS",
      includesAll: [
        /manager/,
        /pin/,
        /window/,
        /alwaysOnTop/,
        /interact/,
        /remote-ledger/,
        /fill-input/,
      ],
    },
    {
      type: "custom",
      name: "view shell API received exact deterministic requests",
      predicate: () => {
        const expected = [
          {
            body: undefined,
            method: "GET",
            pathname: "/api/views/current",
            response: { body: { ok: true }, status: 200 },
            search: "",
          },
          {
            body: { path: "/views" },
            method: "POST",
            pathname: "/api/views/__view-manager__/navigate",
            response: { body: { ok: true }, status: 200 },
            search: "",
          },
          {
            body: undefined,
            method: "GET",
            pathname: "/api/views",
            response: { body: { views }, status: 200 },
            search: "",
          },
          {
            body: { action: "pin-tab", alwaysOnTop: false },
            method: "POST",
            pathname: "/api/views/remote-ledger/navigate",
            response: { body: { ok: true }, status: 200 },
            search: "",
          },
          {
            body: undefined,
            method: "GET",
            pathname: "/api/views",
            response: { body: { views }, status: 200 },
            search: "",
          },
          {
            body: { action: "open-window", alwaysOnTop: true },
            method: "POST",
            pathname: "/api/views/remote-ledger/navigate",
            response: { body: { ok: true }, status: 200 },
            search: "",
          },
          {
            body: undefined,
            method: "GET",
            pathname: "/api/views",
            response: { body: { views }, status: 200 },
            search: "",
          },
          {
            body: {
              capability: "fill-input",
              params: { name: "view-title", value: "Remote Ledger Updated" },
              timeoutMs: 5000,
              viewType: "gui",
            },
            method: "POST",
            pathname: "/api/views/remote-ledger/interact",
            response: {
              body: {
                ok: true,
                capability: "fill-input",
                value: "Remote Ledger Updated",
              },
              status: 200,
            },
            search: "?viewType=gui",
          },
        ];

        const actual = readAppControlHttpRequests((request) =>
          request.pathname.startsWith("/api/views"),
        ).map((request) => ({
          body: request.body,
          method: request.method,
          pathname: request.pathname,
          response: request.response,
          search: request.search,
        }));

        return JSON.stringify(actual) === JSON.stringify(expected)
          ? undefined
          : `expected exact view shell API requests ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
      },
    },
  ],
});
