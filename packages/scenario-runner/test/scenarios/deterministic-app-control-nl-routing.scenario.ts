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
  resetAppControlHttpStub,
} from "./_helpers/app-control-http-stub";

type RuntimeWithScenarioLlmFixtures = {
  scenarioLlmFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    current = toRecord(current)[segment];
  }
  return current;
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function expectRoutedAction(
  execution: ScenarioTurnExecution,
  expected: {
    actionName: string;
    parameters: Record<string, unknown>;
    resultFields: Record<string, unknown>;
  },
): string | undefined {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === expected.actionName,
  ) as CapturedAction | undefined;
  if (!action) {
    return `expected ${expected.actionName} action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }

  const params = toRecord(action.parameters);
  for (const [key, expectedValue] of Object.entries(expected.parameters)) {
    if (!valuesEqual(params[key], expectedValue)) {
      return `expected ${expected.actionName} parameter ${key}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(params[key])}`;
    }
  }

  if (action.result?.success !== true) {
    return `expected ${expected.actionName} result.success=true, saw ${JSON.stringify(action.result)}`;
  }

  for (const [path, expectedValue] of Object.entries(expected.resultFields)) {
    const actual = readPath(action.result, path);
    if (!valuesEqual(actual, expectedValue)) {
      return `expected ${expected.actionName} result.${path}=${JSON.stringify(expectedValue)}, saw ${JSON.stringify(actual)}`;
    }
  }

  return undefined;
}

function handleResponseFixture(input: string, actionName: "APP" | "VIEWS") {
  const args = {
    shouldRespond: "RESPOND",
    contexts: ["actions"],
    intents: [input.toLowerCase()],
    replyText: "On it.",
    candidateActionNames: [actionName],
    facts: [],
    relationships: [],
    addressedTo: [],
    emotion: "none",
  };

  return {
    name: `route-${actionName.toLowerCase()}-stage1-${input}`,
    match: {
      modelType: ModelType.RESPONSE_HANDLER,
      input,
      toolName: "HANDLE_RESPONSE",
    },
    response: {
      text: JSON.stringify(args),
      finishReason: "tool-calls",
      toolCalls: [
        {
          id: `call-${actionName.toLowerCase()}-handle-response`,
          name: "HANDLE_RESPONSE",
          type: "function",
          arguments: args,
        },
      ],
    },
    times: 1,
  };
}

function plannerFixture(
  input: string,
  actionName: "APP" | "VIEWS",
  args: Record<string, unknown>,
) {
  return {
    name: `route-${actionName.toLowerCase()}-planner-${input}`,
    match: {
      modelType: ModelType.ACTION_PLANNER,
      input,
      toolName: actionName,
    },
    response: {
      text: "",
      finishReason: "tool-calls",
      toolCalls: [
        {
          id: `call-${actionName.toLowerCase()}-${String(args.action)}`,
          name: actionName,
          type: "function",
          arguments: args,
        },
      ],
    },
    times: 1,
  };
}

const views = [
  {
    id: "remote-ledger",
    label: "Remote Ledger",
    viewType: "gui",
    description: "Track finance balances and remote ledger entries.",
    path: "/remote-ledger",
    pluginName: "@elizaos/plugin-remote-ledger",
    available: true,
    tags: ["finance", "ledger"],
  },
  {
    id: "settings",
    label: "Settings",
    viewType: "gui",
    description: "Configure local runtime preferences.",
    path: "/settings",
    pluginName: "core",
    available: true,
    tags: ["settings"],
  },
];

const installedApps = [
  {
    name: "feed",
    displayName: "Feed",
    pluginName: "@elizaos/plugin-feed",
    version: "1.0.0",
    installedAt: "2026-05-29T12:00:00.000Z",
  },
  {
    name: "calendar",
    displayName: "Calendar",
    pluginName: "@elizaos/plugin-calendar",
    version: "1.0.0",
    installedAt: "2026-05-29T12:00:00.000Z",
  },
];

function appRun(runId: string) {
  return {
    runId,
    appName: "feed",
    displayName: "Feed",
    pluginName: "@elizaos/plugin-feed",
    launchType: "view",
    launchUrl: "/apps/feed",
    status: "running",
    summary: "Feed app runtime",
    startedAt: "2026-05-29T12:00:00.000Z",
    updatedAt: "2026-05-29T12:00:00.000Z",
    lastHeartbeatAt: "2026-05-29T12:00:00.000Z",
  };
}

function launchResponse(runId: string) {
  return {
    pluginInstalled: true,
    needsRestart: false,
    displayName: "Feed",
    launchType: "view",
    launchUrl: "/apps/feed",
    run: appRun(runId),
  };
}

function normalizedRequests() {
  return readAppControlHttpRequests().map((request) => ({
    body: request.body ?? null,
    method: request.method,
    pathname: request.pathname,
    response: request.response
      ? {
          body: request.response.body ?? null,
          status: request.response.status,
        }
      : null,
    search: request.search,
  }));
}

export default scenario({
  id: "deterministic-app-control-nl-routing",
  title: "Deterministic app-control natural-language routing",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "app-control", "nl-routing"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  seed: [
    {
      type: "custom",
      name: "register strict LLM fixtures and app-control loopback APIs",
      apply: (ctx) => {
        resetAppControlHttpStub();
        const runtime = ctx.runtime as RuntimeWithScenarioLlmFixtures;
        runtime.scenarioLlmFixtures?.register(
          handleResponseFixture("Open the settings view", "VIEWS"),
          plannerFixture("Open the settings view", "VIEWS", {
            action: "show",
            view: "settings",
            viewType: "gui",
          }),
          handleResponseFixture("Search views for finance", "VIEWS"),
          plannerFixture("Search views for finance", "VIEWS", {
            action: "search",
            query: "finance",
            viewType: "gui",
          }),
          handleResponseFixture("Launch the feed app", "APP"),
          plannerFixture("Launch the feed app", "APP", {
            action: "launch",
            app: "feed",
          }),
          handleResponseFixture("Create a feed dashboard app", "APP"),
          plannerFixture("Create a feed dashboard app", "APP", {
            action: "create",
            intent: "Create a feed dashboard app",
          }),
          handleResponseFixture("cancel", "APP"),
          plannerFixture("cancel", "APP", {
            action: "create",
            choice: "cancel",
          }),
          handleResponseFixture("Delete the remote ledger view", "VIEWS"),
          plannerFixture("Delete the remote ledger view", "VIEWS", {
            action: "delete",
            view: "remote-ledger",
            confirm: "true",
          }),
        );

        registerAppControlHttpHandler((request) => {
          if (request.method === "GET" && request.pathname === "/api/views") {
            return jsonResponse({ views });
          }

          if (
            request.method === "GET" &&
            request.pathname === "/api/views/search"
          ) {
            return jsonResponse({
              results: [{ ...views[0], _score: 91 }],
            });
          }

          if (
            request.method === "POST" &&
            request.pathname === "/api/views/settings/navigate"
          ) {
            return jsonResponse({
              ok: true,
              navigated: true,
              viewId: "settings",
            });
          }

          if (
            request.method === "GET" &&
            request.pathname === "/api/apps/installed"
          ) {
            return jsonResponse(installedApps);
          }

          if (
            request.method === "POST" &&
            request.pathname === "/api/apps/launch"
          ) {
            return jsonResponse(launchResponse("run-feed-nl-1"));
          }

          if (
            request.method === "POST" &&
            request.pathname === "/api/apps/stop"
          ) {
            return jsonResponse({
              message: "Plugin @elizaos/plugin-remote-ledger unloaded.",
            });
          }

          return undefined;
        });

        return undefined;
      },
    },
  ],
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Deterministic App Control NL Routing",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "natural language opens a view",
      text: "Open the settings view",
      responseIncludesAny: ["Navigated to Settings"],
      assertTurn: (execution) =>
        expectRoutedAction(execution, {
          actionName: "VIEWS",
          parameters: { action: "show", view: "settings", viewType: "gui" },
          resultFields: {
            "values.mode": "show",
            "values.viewId": "settings",
          },
        }),
    },
    {
      kind: "message",
      name: "natural language searches views",
      text: "Search views for finance",
      responseIncludesAny: ['Views matching "finance" (1):', "Remote Ledger"],
      assertTurn: (execution) =>
        expectRoutedAction(execution, {
          actionName: "VIEWS",
          parameters: { action: "search", query: "finance", viewType: "gui" },
          resultFields: {
            "values.mode": "search",
            "values.query": "finance",
            "data.results.0.view.id": "remote-ledger",
          },
        }),
    },
    {
      kind: "message",
      name: "natural language launches an app",
      text: "Launch the feed app",
      responseIncludesAny: ["Launched Feed", "run-feed-nl-1"],
      assertTurn: (execution) =>
        expectRoutedAction(execution, {
          actionName: "APP",
          parameters: { action: "launch", app: "feed" },
          resultFields: {
            "values.mode": "launch",
            "values.appName": "feed",
            "values.runId": "run-feed-nl-1",
          },
        }),
    },
    {
      kind: "message",
      name: "natural language enters app create choice flow",
      text: "Create a feed dashboard app",
      responseIncludesAny: ["[CHOICE:app-create", "edit-1 = Edit existing"],
      assertTurn: (execution) =>
        expectRoutedAction(execution, {
          actionName: "APP",
          parameters: {
            action: "create",
            intent: "Create a feed dashboard app",
          },
          resultFields: {
            "values.mode": "create",
            "values.subMode": "choice",
            "values.matchCount": 1,
          },
        }),
    },
    {
      kind: "message",
      name: "natural language cancels pending app create flow",
      text: "cancel",
      responseIncludesAny: ["Canceled. No app changes made."],
      assertTurn: (execution) =>
        expectRoutedAction(execution, {
          actionName: "APP",
          parameters: { action: "create", choice: "cancel" },
          resultFields: {
            "values.mode": "create",
            "values.subMode": "cancel",
          },
        }),
    },
    {
      kind: "message",
      name: "natural language deletes a view with explicit confirmation",
      text: "Delete the remote ledger view",
      responseIncludesAny: ["Deleted Remote Ledger"],
      assertTurn: (execution) =>
        expectRoutedAction(execution, {
          actionName: "VIEWS",
          parameters: {
            action: "delete",
            view: "remote-ledger",
            confirm: "true",
          },
          resultFields: {
            "values.mode": "delete",
            "values.viewId": "remote-ledger",
            "values.pluginName": "@elizaos/plugin-remote-ledger",
          },
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "VIEWS",
      status: "success",
      minCount: 3,
    },
    {
      type: "actionCalled",
      actionName: "APP",
      status: "success",
      minCount: 3,
    },
    {
      type: "custom",
      name: "strict natural-language routing hit exact app-control APIs",
      predicate: () => {
        const expected = [
          {
            body: null,
            method: "GET",
            pathname: "/api/views",
            response: { body: { views }, status: 200 },
            search: "?viewType=gui",
          },
          {
            body: { path: "/settings", viewType: "gui" },
            method: "POST",
            pathname: "/api/views/settings/navigate",
            response: {
              body: { ok: true, navigated: true, viewId: "settings" },
              status: 200,
            },
            search: "?viewType=gui",
          },
          {
            body: null,
            method: "GET",
            pathname: "/api/views/search",
            response: {
              body: { results: [{ ...views[0], _score: 91 }] },
              status: 200,
            },
            search: "?q=finance&limit=5&viewType=gui",
          },
          {
            body: null,
            method: "GET",
            pathname: "/api/apps/installed",
            response: { body: installedApps, status: 200 },
            search: "",
          },
          {
            body: { name: "feed" },
            method: "POST",
            pathname: "/api/apps/launch",
            response: { body: launchResponse("run-feed-nl-1"), status: 200 },
            search: "",
          },
          {
            body: null,
            method: "GET",
            pathname: "/api/apps/installed",
            response: { body: installedApps, status: 200 },
            search: "",
          },
          {
            body: null,
            method: "GET",
            pathname: "/api/views",
            response: { body: { views }, status: 200 },
            search: "",
          },
          {
            body: { name: "@elizaos/plugin-remote-ledger" },
            method: "POST",
            pathname: "/api/apps/stop",
            response: {
              body: {
                message: "Plugin @elizaos/plugin-remote-ledger unloaded.",
              },
              status: 200,
            },
            search: "",
          },
        ];
        const actual = normalizedRequests();
        return JSON.stringify(actual) === JSON.stringify(expected)
          ? undefined
          : `expected exact NL app-control HTTP ledger ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
      },
    },
  ],
});
