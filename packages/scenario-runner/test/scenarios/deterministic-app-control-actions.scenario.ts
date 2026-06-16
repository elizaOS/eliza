import { promises as fs } from "node:fs";
import path from "node:path";
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

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function actionParameters(value: unknown): Record<string, unknown> {
  const params = toRecord(value);
  return toRecord(params.parameters ?? params);
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

  const params = actionParameters(action.parameters);
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

const appLoadDirectory = "/tmp/eliza-app-control-scenario-load/apps";
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const feedPluginDir = path.join(repoRoot, "plugins", "plugin-feed");

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
  {
    id: "feed-board",
    label: "Feed Board",
    viewType: "gui",
    description: "Review feed posts and editorial queues.",
    path: "/feed-board",
    pluginName: "@elizaos/plugin-feed",
    available: true,
    tags: ["feed", "editorial"],
  },
];

const currentView = {
  viewId: "remote-ledger",
  viewPath: "/remote-ledger",
  viewLabel: "Remote Ledger",
  viewType: "gui",
  action: "show",
  updatedAt: "2026-05-29T12:00:30.000Z",
};

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

function unloadPluginResponse(pluginName: string) {
  return {
    success: true,
    appName: "feed",
    runId: null,
    stoppedAt: "2026-05-29T12:02:00.000Z",
    pluginUninstalled: true,
    needsRestart: true,
    stopScope: "plugin-uninstalled",
    message: `Plugin ${pluginName} unloaded.`,
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
      name: "register app-control loopback APIs for deterministic APP and VIEWS actions",
      apply: () => {
        process.env.ELIZA_REPO_ROOT = repoRoot;
        process.env.ELIZA_WORKSPACE_DIR = repoRoot;
        resetAppControlHttpLoopback();
        let launchCount = 0;

        registerAppControlHttpHandler((request) => {
          if (request.method === "GET" && request.pathname === "/api/views") {
            return jsonResponse({ views });
          }

          if (
            request.method === "GET" &&
            request.pathname === "/api/views/current"
          ) {
            return jsonResponse({ currentView });
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
            request.pathname === "/api/views/remote-ledger/navigate"
          ) {
            return jsonResponse({
              ok: true,
              navigated: true,
              viewId: "remote-ledger",
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
                launchCount === 1 ? "run-feed-launch-1" : "run-feed-relaunch-2",
              ),
            );
          }

          if (
            request.method === "POST" &&
            request.pathname === "/api/apps/runs/run-feed-old/stop"
          ) {
            return jsonResponse(stopResponse("run-feed-old"));
          }

          if (
            request.method === "POST" &&
            request.pathname === "/api/apps/stop"
          ) {
            return jsonResponse(unloadPluginResponse("@elizaos/plugin-feed"));
          }

          return undefined;
        });

        return undefined;
      },
    },
    {
      type: "custom",
      name: "seed deterministic APP/VIEWS management dependencies",
      apply: async (ctx) => {
        const runtime = ctx.runtime as
          | {
              actions?: Array<{
                name: string;
                validate?: (...args: unknown[]) => Promise<boolean> | boolean;
                handler?: (...args: unknown[]) => Promise<unknown> | unknown;
              }>;
              agentId?: string;
              getService?: (serviceType: string) => unknown;
              createTask?: (task: Record<string, unknown>) => Promise<string>;
              deleteTask?: (taskId: string) => Promise<void>;
              getTasks?: (
                query?: Record<string, unknown>,
              ) => Promise<unknown[]>;
            }
          | undefined;
        if (!runtime?.actions) {
          return "runtime actions unavailable";
        }

        await fs.rm(path.dirname(appLoadDirectory), {
          force: true,
          recursive: true,
        });
        const loadedAppDir = path.join(appLoadDirectory, "app-loaded-console");
        await fs.mkdir(loadedAppDir, { recursive: true });
        await fs.writeFile(
          path.join(loadedAppDir, "package.json"),
          `${JSON.stringify(
            {
              name: "@scenario/app-loaded-console",
              version: "1.0.0",
              elizaos: {
                app: {
                  slug: "loaded-console",
                  displayName: "Loaded Console",
                  aliases: ["loaded"],
                  permissions: {},
                  isolation: "worker",
                },
              },
            },
            null,
            2,
          )}\n`,
          "utf8",
        );

        let nextTaskId = 1;
        const scenarioTasks: Array<Record<string, unknown> & { id: string }> =
          [];
        runtime.createTask = async (task: Record<string, unknown>) => {
          const id = `00000000-0000-4000-8000-${String(nextTaskId).padStart(12, "0")}`;
          nextTaskId += 1;
          scenarioTasks.push({
            ...task,
            agentId:
              typeof task.agentId === "string" ? task.agentId : runtime.agentId,
            id,
          });
          return id;
        };
        runtime.getTasks = async (query: Record<string, unknown> = {}) => {
          const wantedTags = Array.isArray(query.tags)
            ? query.tags.filter((tag): tag is string => typeof tag === "string")
            : [];
          const wantedAgentIds = Array.isArray(query.agentIds)
            ? query.agentIds.filter(
                (id): id is string => typeof id === "string",
              )
            : [];
          return scenarioTasks.filter((task) => {
            const tags = Array.isArray(task.tags)
              ? task.tags.filter(
                  (tag): tag is string => typeof tag === "string",
                )
              : [];
            const agentId =
              typeof task.agentId === "string" ? task.agentId : "";
            return (
              wantedTags.every((tag) => tags.includes(tag)) &&
              (wantedAgentIds.length === 0 ||
                agentId.length === 0 ||
                wantedAgentIds.includes(agentId))
            );
          });
        };
        runtime.deleteTask = async (taskId: string) => {
          const index = scenarioTasks.findIndex((task) => task.id === taskId);
          if (index >= 0) scenarioTasks.splice(index, 1);
        };

        if (
          !runtime.actions.some((action) => action.name === "START_CODING_TASK")
        ) {
          runtime.actions.push({
            name: "START_CODING_TASK",
            validate: async () => true,
            handler: async (_runtime, _message, _state, options) => {
              const parameters =
                options &&
                typeof options === "object" &&
                !Array.isArray(options) &&
                "parameters" in options &&
                typeof (options as { parameters?: unknown }).parameters ===
                  "object" &&
                (options as { parameters?: unknown }).parameters !== null
                  ? (options as { parameters: Record<string, unknown> })
                      .parameters
                  : {};
              const label =
                typeof parameters.label === "string"
                  ? parameters.label
                  : "coding-task";
              const workdir =
                typeof parameters.workdir === "string"
                  ? parameters.workdir
                  : feedPluginDir;
              const sessionId = `scenario-${label.replace(/[^a-z0-9-]/gi, "-")}`;
              return {
                success: true,
                data: {
                  agents: [
                    {
                      sessionId,
                      agentType: "codex",
                      workdir,
                      label,
                      status: "running",
                      workspaceId: "scenario-workspace",
                      branch: "shaw/scenario-app-control",
                    },
                  ],
                },
              };
            },
          });
        }

        const registeredApps: unknown[] = [];
        const fakeRegistryService = {
          register: async (entry: unknown) => {
            registeredApps.push(entry);
          },
          recordManifestRejection: async () => undefined,
          readRegisteredForTest: () => [...registeredApps],
        };
        const previousGetService = runtime.getService?.bind(runtime);
        runtime.getService = (serviceType: string) => {
          if (serviceType === "app-registry") return fakeRegistryService;
          return previousGetService?.(serviceType) ?? null;
        };

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
            "available_views:\n  type: gui\n  count: 3\nviews[3]{id,label,type,path,available}:\n  remote-ledger,Remote Ledger,gui,/remote-ledger,yes\n  settings,Settings,gui,/settings,yes\n  feed-board,Feed Board,gui,/feed-board,yes",
          resultFields: {
            "values.mode": "list",
            "values.viewCount": 3,
            "values.viewType": "gui",
            "data.views.0.id": "remote-ledger",
            "data.views.1.id": "settings",
            "data.views.2.id": "feed-board",
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
      name: "open remote ledger view",
      text: "Open the remote ledger view",
      actionName: "VIEWS",
      options: { action: "open", view: "remote-ledger", viewType: "gui" },
      responseIncludesAny: ["Navigated to Remote Ledger"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: {
            action: "open",
            view: "remote-ledger",
            viewType: "gui",
          },
          responseText: "Navigated to Remote Ledger (gui).",
          resultFields: {
            "values.mode": "show",
            "values.viewId": "remote-ledger",
            "values.label": "Remote Ledger",
            "data.view.path": "/remote-ledger",
          },
        }),
    },
    {
      kind: "action",
      name: "read current view",
      text: "What is the current view?",
      actionName: "VIEWS",
      options: { action: "current" },
      responseIncludesAny: ["Current view: Remote Ledger"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: { action: "current" },
          responseText:
            "Current view: Remote Ledger (gui) — remote-ledger at /remote-ledger.",
          resultFields: {
            "values.mode": "current",
            "values.viewId": "remote-ledger",
            "values.viewType": "gui",
            "data.currentView.viewPath": "/remote-ledger",
          },
        }),
    },
    {
      kind: "action",
      name: "split ledger and settings views",
      text: "Split the remote ledger and settings views horizontally",
      actionName: "VIEWS",
      options: {
        action: "split",
        layout: "horizontal",
        views: ["remote-ledger", "settings"],
      },
      responseIncludesAny: ["Split views: Remote Ledger, Settings"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: {
            action: "split",
            layout: "horizontal",
            views: ["remote-ledger", "settings"],
          },
          responseText: "Split views: Remote Ledger, Settings (horizontal).",
          resultFields: {
            "values.mode": "split",
            "values.layout": "horizontal",
            "values.viewIds.0": "remote-ledger",
            "values.viewIds.1": "settings",
            "data.action": "split-view",
          },
        }),
    },
    {
      kind: "action",
      name: "tile ledger and settings views",
      text: "Tile the remote ledger and settings views",
      actionName: "VIEWS",
      options: {
        action: "tile",
        views: ["remote-ledger", "settings"],
      },
      responseIncludesAny: ["Tiled views: Remote Ledger, Settings"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: {
            action: "tile",
            views: ["remote-ledger", "settings"],
          },
          responseText: "Tiled views: Remote Ledger, Settings.",
          resultFields: {
            "values.mode": "tile",
            "values.layout": "grid",
            "values.viewIds.0": "remote-ledger",
            "values.viewIds.1": "settings",
            "data.action": "tile-views",
          },
        }),
    },
    {
      kind: "action",
      name: "close settings view",
      text: "Close the settings view",
      actionName: "VIEWS",
      options: { action: "close", view: "settings" },
      responseIncludesAny: ["Closed Settings"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: { action: "close", view: "settings" },
          responseText: "Closed Settings.",
          resultFields: {
            "values.mode": "close",
            "values.viewId": "settings",
            "values.viewType": "gui",
            "data.action": "close",
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
      name: "reset homescreen scene",
      text: "Reset the homescreen to default",
      actionName: "HOMESCREEN",
      options: { op: "reset" },
      responseIncludesAny: ["Reset the homescreen to the default crystal ball"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "HOMESCREEN",
          parameters: { op: "reset" },
          responseText: "Reset the homescreen to the default crystal ball.",
          resultFields: {
            "values.mode": "reset",
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
    {
      kind: "action",
      name: "create-mode edit feed board view",
      text: "Create improvements for the feed board view",
      actionName: "VIEWS",
      options: {
        action: "create",
        editTarget: "feed-board",
        intent: "Make feed board show compact moderation lanes",
      },
      responseIncludesAny: ["Started view edit task for Feed Board"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: {
            action: "create",
            editTarget: "feed-board",
            intent: "Make feed board show compact moderation lanes",
          },
          responseText: `Started view edit task for Feed Board at ${feedPluginDir}. Task session scenario-edit-view-feed-board is running.`,
          resultFields: {
            "values.mode": "create",
            "values.subMode": "edit",
            "values.viewId": "feed-board",
            "values.workdir": feedPluginDir,
            "values.taskSessionId": "scenario-edit-view-feed-board",
            "data.task.label": "edit-view:feed-board",
          },
        }),
    },
    {
      kind: "action",
      name: "edit feed board view",
      text: "Edit the feed board view",
      actionName: "VIEWS",
      options: {
        action: "edit",
        intent: "Make feed board show denser queue rows",
        view: "feed-board",
      },
      responseIncludesAny: ["Started view edit task for Feed Board"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: {
            action: "edit",
            intent: "Make feed board show denser queue rows",
            view: "feed-board",
          },
          responseText: `Started view edit task for Feed Board at ${feedPluginDir}. Task session scenario-edit-view-feed-board is running.`,
          resultFields: {
            "values.mode": "edit",
            "values.viewId": "feed-board",
            "values.workdir": feedPluginDir,
            "values.taskSessionId": "scenario-edit-view-feed-board",
            "data.task.label": "edit-view:feed-board",
          },
        }),
    },
    {
      kind: "action",
      name: "delete feed board view",
      text: "Delete the feed board view",
      actionName: "VIEWS",
      options: { action: "delete", confirm: "true", view: "feed-board" },
      responseIncludesAny: ["Deleted Feed Board"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: {
            action: "delete",
            confirm: "true",
            view: "feed-board",
          },
          responseText:
            "Deleted Feed Board (@elizaos/plugin-feed). Plugin @elizaos/plugin-feed unloaded.",
          resultFields: {
            "values.mode": "delete",
            "values.viewId": "feed-board",
            "values.pluginName": "@elizaos/plugin-feed",
            "data.unloadResult.ok": true,
          },
        }),
    },
    {
      kind: "action",
      name: "remove feed board view alias",
      text: "Remove the feed board view",
      actionName: "VIEWS",
      options: { action: "remove", confirm: "true", view: "feed-board" },
      responseIncludesAny: ["Deleted Feed Board"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "VIEWS",
          parameters: {
            action: "remove",
            confirm: "true",
            view: "feed-board",
          },
          responseText:
            "Deleted Feed Board (@elizaos/plugin-feed). Plugin @elizaos/plugin-feed unloaded.",
          resultFields: {
            "values.mode": "delete",
            "values.viewId": "feed-board",
            "values.pluginName": "@elizaos/plugin-feed",
            "data.unloadResult.ok": true,
          },
        }),
    },
    {
      kind: "action",
      name: "load apps from directory",
      text: "Load apps from the scenario directory",
      actionName: "APP",
      options: { action: "load_from_directory", directory: appLoadDirectory },
      responseIncludesAny: ["Registered 1 app", "Loaded Console"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "APP",
          parameters: {
            action: "load_from_directory",
            directory: appLoadDirectory,
          },
          responseText: `Registered 1 app from ${appLoadDirectory}:\n  - Loaded Console (@scenario/app-loaded-console)\n\nApps are registered only — none were launched.`,
          resultFields: {
            "values.mode": "load_from_directory",
            "values.directory": appLoadDirectory,
            "values.registeredCount": 1,
            "values.rejectedCount": 0,
            "data.registered.0.slug": "loaded-console",
            "data.registered.0.canonicalName": "@scenario/app-loaded-console",
          },
        }),
    },
    {
      kind: "action",
      name: "edit feed app",
      text: "Edit the feed app",
      actionName: "APP",
      options: {
        action: "create",
        editTarget: "feed",
        intent: "Tighten the feed app table density",
      },
      responseIncludesAny: ["Started app edit task for Feed"],
      assertTurn: (execution) =>
        expectActionTurn(execution, {
          actionName: "APP",
          parameters: {
            action: "create",
            editTarget: "feed",
            intent: "Tighten the feed app table density",
          },
          responseText: `Started app edit task for Feed at ${feedPluginDir}. Task session scenario-edit-app-feed is running; verification will run when it emits APP_CREATE_DONE.`,
          resultFields: {
            "values.mode": "create",
            "values.subMode": "edit",
            "values.name": "feed",
            "values.workdir": feedPluginDir,
            "values.taskSessionId": "scenario-edit-app-feed",
            "data.task.label": "edit-app:feed",
          },
        }),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "VIEWS",
      status: "success",
      minCount: 13,
    },
    {
      type: "actionCalled",
      actionName: "APP",
      status: "success",
      minCount: 5,
    },
    {
      type: "selectedActionArguments",
      actionName: "VIEWS",
      includesAll: [
        /"list"/,
        /"search"/,
        /"show"/,
        /"open"/,
        /"split"/,
        /"tile"/,
        /"close"/,
        /"current"/,
        /"broadcast"/,
        /wallet:refresh/,
        /remote-ledger/,
        /settings/,
        /feed-board/,
        /"create"/,
        /"edit"/,
        /"delete"/,
        /"remove"/,
      ],
    },
    {
      type: "selectedActionArguments",
      actionName: "APP",
      includesAll: [
        /"list"/,
        /"launch"/,
        /"relaunch"/,
        /"load_from_directory"/,
        /"create"/,
        /run-feed-launch-1/,
        /run-feed-relaunch-2/,
        /loaded-console/,
        /editTarget/,
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
            body: null,
            method: "GET",
            pathname: "/api/views",
            response: { body: { views }, status: 200 },
            search: "?viewType=gui",
          },
          {
            body: { path: "/remote-ledger", viewType: "gui" },
            method: "POST",
            pathname: "/api/views/remote-ledger/navigate",
            response: {
              body: { ok: true, navigated: true, viewId: "remote-ledger" },
              status: 200,
            },
            search: "?viewType=gui",
          },
          {
            body: null,
            method: "GET",
            pathname: "/api/views/current",
            response: { body: { currentView }, status: 200 },
            search: "",
          },
          {
            body: { type: "wallet:refresh", payload: { source: "scenario" } },
            method: "POST",
            pathname: "/api/views/events/broadcast",
            response: { body: { ok: true, delivered: 2 }, status: 200 },
            search: "",
          },
          {
            body: { type: "homescreen:apply", payload: { op: "reset" } },
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
            response: {
              body: launchResponse("run-feed-launch-1"),
              status: 200,
            },
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
          {
            body: null,
            method: "GET",
            pathname: "/api/views",
            response: { body: { views }, status: 200 },
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
            body: null,
            method: "GET",
            pathname: "/api/views",
            response: { body: { views }, status: 200 },
            search: "",
          },
          {
            body: { name: "@elizaos/plugin-feed" },
            method: "POST",
            pathname: "/api/apps/stop",
            response: {
              body: unloadPluginResponse("@elizaos/plugin-feed"),
              status: 200,
            },
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
            body: { name: "@elizaos/plugin-feed" },
            method: "POST",
            pathname: "/api/apps/stop",
            response: {
              body: unloadPluginResponse("@elizaos/plugin-feed"),
              status: 200,
            },
            search: "",
          },
          {
            body: null,
            method: "GET",
            pathname: "/api/apps/installed",
            response: { body: installedApps, status: 200 },
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
