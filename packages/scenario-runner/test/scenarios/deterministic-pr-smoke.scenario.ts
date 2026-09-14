/**
 * Fast keyless smoke covering the core scenario surfaces (views, actions, routing)
 * in one pass. Runs on the pr-deterministic lane under the model provider.
 */
import { ModelType } from "@elizaos/core";
import { matchesScenarioInput } from "@elizaos/core/testing";
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

type RuntimeWithScenarioModelFixtures = {
  scenarioModelFixtures?: {
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
  lane: "pr-deterministic",
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
        const runtime = ctx.runtime as RuntimeWithScenarioModelFixtures;
        runtime.scenarioModelFixtures?.register(
          // The simple-reply path answers straight from the stage-1 router
          // response (`replyText`); no follow-up TEXT_SMALL call fires. The
          // router fixture is therefore the required one, and the direct
          // TEXT_SMALL fixture stays registered only as an optional guard so
          // a regression that reintroduces the second call still resolves
          // deterministically instead of failing strict-mode.
          {
            name: "pr-smoke-deterministic-direct-reply",
            match: {
              modelType: ModelType.TEXT_SMALL,
              input: "hello deterministic provider",
            },
            response:
              "deterministic-test-response: hello deterministic provider",
            required: false,
            times: { min: 0, max: 1 },
          },
          {
            name: "pr-smoke-conversation-needs-no-view",
            match: {
              modelType: ModelType.TEXT_SMALL,
              prompt: (prompt: string) =>
                prompt.includes(
                  "Classify visual continuation for the complete user request using only the authorized live catalog below.",
                ) &&
                prompt.endsWith(
                  'Complete user request: "hello deterministic provider"',
                ),
            },
            response: JSON.stringify({
              disposition: "none",
              reason: "A greeting does not require a visual surface.",
            }),
            times: 1,
          },
          {
            name: "pr-smoke-deterministic-router-reply",
            match: {
              modelType: ModelType.RESPONSE_HANDLER,
              input: matchesScenarioInput("hello deterministic provider"),
              toolName: "HANDLE_RESPONSE",
            },
            response: {
              shouldRespond: "RESPOND",
              contexts: ["simple"],
              intents: [],
              replyEffectStatus: "none",
              replyText:
                "deterministic-test-response: hello deterministic provider",
              candidateActionNames: [],
              facts: [],
              relationships: [],
              addressedTo: [],
              emotion: "none",
            },
            times: 1,
          },
        );
        registerAppControlHttpHandler((request) => {
          if (!request.pathname.startsWith("/api/views")) return undefined;
          if (request.method === "GET" && request.pathname === "/api/views") {
            return jsonResponse({ views });
          }
          if (request.pathname.endsWith("/interact")) {
            // The interact route contract carries an authoritative `success`
            // boolean (parseViewInteractionResponse rejects bodies without
            // one); the receipt summary filters `success` out, so the visible
            // "(returned ok, capability, value)" text is unchanged.
            return jsonResponse({
              success: true,
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
      source: "chat",
      title: "Deterministic PR Smoke",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "deterministic reply",
      text: "hello deterministic provider",
      responseIncludesAny: [
        "deterministic-test-response: hello deterministic provider",
      ],
      assertTurn: (execution) =>
        execution.responseText ===
        "deterministic-test-response: hello deterministic provider"
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
      assertTurn: (execution) => {
        const action = execution.actionsCalled.find(
          (candidate) => candidate.actionName === "VIEWS",
        );
        const data = action?.result?.data;
        const receipt =
          data && typeof data === "object" && "result" in data
            ? data.result
            : undefined;
        if (
          action?.result?.success !== true ||
          !receipt ||
          typeof receipt !== "object" ||
          !("value" in receipt) ||
          receipt.value !== "Remote Ledger Updated"
        ) {
          return "view interaction did not preserve its successful transport receipt";
        }
        return expectViewsAction(execution, {
          action: "interact",
          capability: "fill-input",
          paramValue: "Remote Ledger Updated",
          // An action-only turn retains the receipt for the planner; it does not fabricate a model-authored answer.
          responseText: "",
          view: "remote-ledger",
        });
      },
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
            pathname: "/api/views",
            response: { body: { views }, status: 200 },
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
                success: true,
                ok: true,
                capability: "fill-input",
                value: "Remote Ledger Updated",
              },
              status: 200,
            },
            search: "?viewType=gui",
          },
        ];

        // The view-context evaluator may discover views independently of an
        // action. Compare ordered effects without counting those read-only polls.
        const isDiscoveryRead = (request: {
          method: string;
          pathname: string;
        }) => request.method === "GET" && request.pathname === "/api/views";
        const expectedEffects = expected.filter(
          (request) => !isDiscoveryRead(request),
        );
        const observed = readAppControlHttpRequests((request) =>
          request.pathname.startsWith("/api/views"),
        ).map((request) => ({
          body: request.body,
          method: request.method,
          pathname: request.pathname,
          response: request.response,
          search: request.search,
        }));
        const expectedReads = expected.filter(isDiscoveryRead);
        const observedReads = observed.filter(isDiscoveryRead);
        if (
          observedReads.length < expectedReads.length ||
          observedReads.some(
            (request) =>
              !expectedReads.some(
                (expectedRead) =>
                  JSON.stringify(request) === JSON.stringify(expectedRead),
              ),
          )
        ) {
          return `view discovery response contract failed: ${JSON.stringify(observedReads)}`;
        }
        const actual = observed.filter((request) => !isDiscoveryRead(request));

        return JSON.stringify(actual) === JSON.stringify(expectedEffects)
          ? undefined
          : `expected exact view shell API effects ${JSON.stringify(expectedEffects)}, saw ${JSON.stringify(actual)}`;
      },
    },
  ],
});
