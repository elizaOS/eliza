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

function expectActionTurn(
  execution: ScenarioTurnExecution,
  expected: {
    actionName: string;
    parameters: Record<string, unknown>;
    responseText: string;
    resultFields: Record<string, unknown>;
  },
): string | undefined {
  if (execution.responseText !== expected.responseText) {
    return `expected responseText=${JSON.stringify(expected.responseText)}, saw ${JSON.stringify(execution.responseText)}`;
  }

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

function stopResponse(runId: string) {
  return {
    success: true,
    appName: "feed",
    runId,
    stoppedAt: "2026-05-29T12:01:00.000Z",
    pluginUninstalled: false,
    needsRestart: false,
    stopScope: "viewer-session",
    message: `Stopped run ${runId}`,
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
  id: "deterministic-app-control-actions",
  title: "Deterministic app-control action catalog",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "app-control"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  seed: [
    {
      type: "custom",
      name: "stub app-control loopback APIs for deterministic APP and VIEWS actions",
      apply: () => {
        resetAppControlHttpStub();
        let launchCount = 0;

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
            request.method === "POST" &&
            request.pathname === "/api/views/events/broadcast"
          ) {
            return jsonResponse({
              ok: true,
              delivered: 2,
            });
          }

          if (
            request.method === "GET" &&
            request.pathname === "/api/apps/installed"
          ) {
            return jsonResponse(installedApps);
          }

          if (
            request.method === "GET" &&
            request.pathname === "/api/apps/runs"
          ) {
            return jsonResponse([appRun("run-feed-old")]);
          }

          if (
            request.method === "POST" &&
            request.pathname === "/api/apps/launch"
          ) {
            launchCount += 1;
            return jsonResponse(
              launchResponse(
                launchCount === 1
                  ? "run-feed-launch-1"
                  : "run-feed-relaunch-2",
              ),
            );
          }

          if (
            request.method === "POST" &&
            request.pathname === "/api/apps/runs/run-feed-old/stop"
          ) {
            return jsonResponse(stopResponse("run-feed-old"));
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
      title: "Deterministic App Control Catalog",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "list gui views",
      text: "List the GUI views",
      actionName: "VIEWS",
      options: { action: "list", viewType: "gui" },
      responseIncludesAny: ["available_views:", "remote-ledger"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: { action: "list", viewType: "gui" },
          responseText:
            "available_views:\n  type: gui\n  count: 2\nviews[2]{id,label,type,path,available}:\n  remote-ledger,Remote Ledger,gui,/remote-ledger,yes\n  settings,Settings,gui,/settings,yes",
          resultFields: {
            "values.mode": "list",
            "values.viewCount": 2,
            "values.viewType": "gui",
            "data.views.0.id": "remote-ledger",
            "data.views.1.id": "settings",
          },
        }),
    },
    {
      kind: "action",
      name: "search finance views",
      text: "Search views for finance",
      actionName: "VIEWS",
      options: { action: "search", query: "finance", viewType: "gui" },
      responseIncludesAny: ['Views matching "finance" (1):', "Remote Ledger"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: { action: "search", query: "finance", viewType: "gui" },
          responseText:
            'Views matching "finance" (1):\n  [91] Remote Ledger (remote-ledger) — /remote-ledger — Track finance balances and remote ledger entries.',
          resultFields: {
            "values.mode": "search",
            "values.query": "finance",
            "values.resultCount": 1,
            "data.results.0.score": 91,
            "data.results.0.view.id": "remote-ledger",
          },
        }),
    },
    {
      kind: "action",
      name: "show settings view",
      text: "Open the settings view",
      actionName: "VIEWS",
      options: { action: "show", view: "settings", viewType: "gui" },
      responseIncludesAny: ["Navigated to Settings"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: { action: "show", view: "settings", viewType: "gui" },
          responseText: "Navigated to Settings (gui).",
          resultFields: {
            "values.mode": "show",
            "values.viewId": "settings",
            "values.label": "Settings",
            "data.view.path": "/settings",
          },
        }),
    },
    {
      kind: "action",
      name: "broadcast view refresh",
      text: "Tell the wallet view to refresh",
      actionName: "VIEWS",
      options: {
        action: "broadcast",
        eventType: "wallet:refresh",
        payload: { source: "scenario" },
      },
      responseIncludesAny: ['Broadcast view event "wallet:refresh"'],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: {
            action: "broadcast",
            eventType: "wallet:refresh",
            payload: { source: "scenario" },
          },
          responseText:
            'Broadcast view event "wallet:refresh" to all connected views.',
          resultFields: {
            "values.mode": "broadcast",
            "values.eventType": "wallet:refresh",
            "data.payload.source": "scenario",
          },
        }),
    },
    {
      kind: "action",
      name: "list installed apps",
      text: "List installed and running apps",
      actionName: "APP",
      options: { action: "list" },
      responseIncludesAny: ["available_apps:", "feed,Feed,run-feed-old"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "APP",
          parameters: { action: "list" },
          responseText:
            "available_apps:\n  installedCount: 2\n  runningCount: 1\napps[2]{name,displayName,runningRunIds}:\n  feed,Feed,run-feed-old\n  calendar,Calendar,none",
          resultFields: {
            "values.mode": "list",
            "values.installedCount": 2,
            "values.runningCount": 1,
            "data.installed.0.name": "feed",
            "data.runs.0.runId": "run-feed-old",
          },
        }),
    },
    {
      kind: "action",
      name: "launch feed app",
      text: "Launch the feed app",
      actionName: "APP",
      options: { action: "launch", app: "feed" },
      responseIncludesAny: ["Launched Feed", "run-feed-launch-1"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "APP",
          parameters: { action: "launch", app: "feed" },
          responseText: "Launched Feed. Run ID: run-feed-launch-1.",
          resultFields: {
            "values.mode": "launch",
            "values.appName": "feed",
            "values.runId": "run-feed-launch-1",
            "data.launch.run.runId": "run-feed-launch-1",
          },
        }),
    },
    {
      kind: "action",
      name: "relaunch feed app",
      text: "Relaunch the feed app",
      actionName: "APP",
      options: { action: "relaunch", app: "feed" },
      responseIncludesAny: ["Relaunched Feed", "run-feed-relaunch-2"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "APP",
          parameters: { action: "relaunch", app: "feed" },
          responseText: "Relaunched Feed. New run ID: run-feed-relaunch-2.",
          resultFields: {
            "values.mode": "relaunch",
            "values.appName": "feed",
            "values.runId": "run-feed-relaunch-2",
            "data.launch.run.runId": "run-feed-relaunch-2",
          },
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "VIEWS",
      status: "success",
      minCount: 4,
    },
    {
      type: "actionCalled",
      actionName: "APP",
      status: "success",
      minCount: 3,
    },
    {
      type: "selectedActionArguments",
      actionName: "VIEWS",
      includesAll: [
        /"list"/,
        /"search"/,
        /"show"/,
        /"broadcast"/,
        /wallet:refresh/,
        /remote-ledger/,
        /settings/,
      ],
    },
    {
      type: "selectedActionArguments",
      actionName: "APP",
      includesAll: [
        /"list"/,
        /"launch"/,
        /"relaunch"/,
        /run-feed-launch-1/,
        /run-feed-relaunch-2/,
      ],
    },
    {
      type: "custom",
      name: "app-control loopback requests and responses are exact",
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
            body: { type: "wallet:refresh", payload: { source: "scenario" } },
            method: "POST",
            pathname: "/api/views/events/broadcast",
            response: { body: { ok: true, delivered: 2 }, status: 200 },
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
            pathname: "/api/apps/runs",
            response: { body: [appRun("run-feed-old")], status: 200 },
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
            body: { name: "feed" },
            method: "POST",
            pathname: "/api/apps/launch",
            response: { body: launchResponse("run-feed-launch-1"), status: 200 },
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
            pathname: "/api/apps/runs",
            response: { body: [appRun("run-feed-old")], status: 200 },
            search: "",
          },
          {
            body: null,
            method: "POST",
            pathname: "/api/apps/runs/run-feed-old/stop",
            response: { body: stopResponse("run-feed-old"), status: 200 },
            search: "",
          },
          {
            body: { name: "feed" },
            method: "POST",
            pathname: "/api/apps/launch",
            response: {
              body: launchResponse("run-feed-relaunch-2"),
              status: 200,
            },
            search: "",
          },
        ];
        const actual = normalizedRequests();
        return JSON.stringify(actual) === JSON.stringify(expected)
          ? undefined
          : `expected exact app-control HTTP ledger ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`;
      },
    },
  ],
});
