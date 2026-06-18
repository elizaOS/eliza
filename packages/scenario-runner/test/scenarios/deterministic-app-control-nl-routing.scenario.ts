import { promises as fs } from "node:fs";
import path from "node:path";
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
  actions?: Array<{
    name: string;
    validate?: (...args: unknown[]) => Promise<boolean> | boolean;
    handler?: (...args: unknown[]) => Promise<unknown> | unknown;
  }>;
  agentId?: string;
  createTask?: (task: Record<string, unknown>) => Promise<string>;
  deleteTask?: (taskId: string) => Promise<void>;
  getService?: (serviceType: string) => unknown;
  getTasks?: (query?: Record<string, unknown>) => Promise<unknown[]>;
  scenarioLlmFixtures?: {
    register: (...fixtures: Array<Record<string, unknown>>) => void;
  };
};

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

function handleResponseFixture(input: string, actionName: "APP" | "VIEWS") {
  const args = {
    contexts: ["settings"],
    intents: [input.toLowerCase()],
    replyText: "On it.",
    threadOps: [],
    candidateActionNames: [actionName],
  };

  return {
    name: `route-${actionName.toLowerCase()}-stage1-${input}`,
    match: {
      modelType: ModelType.RESPONSE_HANDLER,
      input: matchesScenarioInput(input),
      toolName: "HANDLE_RESPONSE",
    },
    response: args,
    times: 1,
  };
}

function plannerFixture(
  input: string,
  actionName: "APP" | "VIEWS",
  args: Record<string, unknown>,
  messageToUser: string,
) {
  return {
    name: `route-${actionName.toLowerCase()}-planner-${input}`,
    match: {
      modelType: ModelType.ACTION_PLANNER,
      input: matchesScenarioInput(input),
      toolName: actionName,
    },
    response: {
      text: "",
      thought: `Call ${actionName} for ${input}.`,
      messageToUser,
      completed: true,
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

const appLoadDirectory = "/tmp/eliza-app-control-nl-routing/apps";
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const feedPluginDir = path.join(repoRoot, "plugins", "plugin-feed");
const loadAppsInput = `Load apps from ${appLoadDirectory} directory`;
const editFeedBoardInput = "Edit view feed-board plugin";

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
      apply: async (ctx) => {
        process.env.ELIZA_REPO_ROOT = repoRoot;
        process.env.ELIZA_WORKSPACE_DIR = repoRoot;
        resetAppControlHttpLoopback();
        const runtime = ctx.runtime as RuntimeWithScenarioLlmFixtures;

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
          !runtime.actions?.some(
            (action) => action.name === "START_CODING_TASK",
          )
        ) {
          runtime.actions?.push({
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

        let launchCount = 0;
        runtime.scenarioLlmFixtures?.register(
          handleResponseFixture("Open the settings view", "VIEWS"),
          plannerFixture(
            "Open the settings view",
            "VIEWS",
            {
              action: "show",
              view: "settings",
              viewType: "gui",
            },
            "Navigated to Settings (gui).",
          ),
          handleResponseFixture("Search views for finance", "VIEWS"),
          plannerFixture(
            "Search views for finance",
            "VIEWS",
            {
              action: "search",
              query: "finance",
              viewType: "gui",
            },
            'Views matching "finance" (1):\n  [91] Remote Ledger (remote-ledger) — /remote-ledger — Track finance balances and remote ledger entries.',
          ),
          handleResponseFixture("Launch the feed app", "APP"),
          plannerFixture(
            "Launch the feed app",
            "APP",
            {
              action: "launch",
              app: "feed",
            },
            "Launched Feed. Run ID: run-feed-nl-1.",
          ),
          handleResponseFixture("Relaunch the feed app", "APP"),
          plannerFixture(
            "Relaunch the feed app",
            "APP",
            {
              action: "relaunch",
              app: "feed",
            },
            "Relaunched Feed. New run ID: run-feed-nl-2.",
          ),
          handleResponseFixture(loadAppsInput, "APP"),
          plannerFixture(
            loadAppsInput,
            "APP",
            {
              action: "load_from_directory",
              directory: appLoadDirectory,
            },
            `Registered 1 app from ${appLoadDirectory}:\n  - Loaded Console (@scenario/app-loaded-console)\n\nApps are registered only — none were launched.`,
          ),
          handleResponseFixture("Create a feed dashboard app", "APP"),
          plannerFixture(
            "Create a feed dashboard app",
            "APP",
            {
              action: "create",
              intent: "Create a feed dashboard app",
            },
            "Picking next step...",
          ),
          handleResponseFixture("Cancel the app create flow", "APP"),
          plannerFixture(
            "Cancel the app create flow",
            "APP",
            {
              action: "create",
              choice: "cancel",
            },
            "Canceled. No app changes made.",
          ),
          handleResponseFixture(editFeedBoardInput, "VIEWS"),
          plannerFixture(
            editFeedBoardInput,
            "VIEWS",
            {
              action: "edit",
              view: "feed-board",
              intent: "Make feed board show denser queue rows",
            },
            `Started view edit task for Feed Board at ${feedPluginDir}. Task session scenario-edit-view-feed-board is running.`,
          ),
          handleResponseFixture("Edit the feed app", "APP"),
          plannerFixture(
            "Edit the feed app",
            "APP",
            {
              action: "create",
              editTarget: "feed",
              intent: "Tighten the feed app table density",
            },
            `Started app edit task for Feed at ${feedPluginDir}. Task session scenario-edit-app-feed is running; verification will run when it emits APP_CREATE_DONE.`,
          ),
          handleResponseFixture("Delete the remote ledger view", "VIEWS"),
          plannerFixture(
            "Delete the remote ledger view",
            "VIEWS",
            {
              action: "delete",
              view: "remote-ledger",
              confirm: "true",
            },
            "Deleted Remote Ledger (@elizaos/plugin-remote-ledger). Plugin @elizaos/plugin-remote-ledger unloaded.",
          ),
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
            launchCount += 1;
            return jsonResponse(
              launchResponse(
                launchCount === 1 ? "run-feed-nl-1" : "run-feed-nl-2",
              ),
            );
          }

          if (
            request.method === "GET" &&
            request.pathname === "/api/apps/runs"
          ) {
            return jsonResponse([appRun("run-feed-old")]);
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
            const pluginName = String(
              toRecord(request.body).name ?? "@elizaos/plugin-remote-ledger",
            );
            return jsonResponse(unloadPluginResponse(pluginName));
          }

          // VIEWS/delete now uninstalls via POST /api/plugins/uninstall
          // (unloadPlugin checks `resp.ok && body.ok`).
          if (
            request.method === "POST" &&
            request.pathname === "/api/plugins/uninstall"
          ) {
            const pluginName = String(
              toRecord(request.body).name ?? "@elizaos/plugin-remote-ledger",
            );
            return jsonResponse({
              ok: true,
              message: `Plugin ${pluginName} unloaded.`,
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
      name: "natural language relaunches an app",
      text: "Relaunch the feed app",
      responseIncludesAny: ["Relaunched Feed", "run-feed-nl-2"],
      assertTurn: (execution) =>
        expectRoutedAction(execution, {
          actionName: "APP",
          parameters: { action: "relaunch", app: "feed" },
          resultFields: {
            "values.mode": "relaunch",
            "values.appName": "feed",
            "values.runId": "run-feed-nl-2",
          },
        }),
    },
    {
      kind: "message",
      name: "natural language loads apps from directory",
      text: loadAppsInput,
      responseIncludesAny: [
        "Registered 1 app",
        "Loaded Console (@scenario/app-loaded-console)",
      ],
      assertTurn: (execution) =>
        expectRoutedAction(execution, {
          actionName: "APP",
          parameters: {
            action: "load_from_directory",
            directory: appLoadDirectory,
          },
          resultFields: {
            "values.mode": "load_from_directory",
            "values.directory": appLoadDirectory,
            "values.registeredCount": 1,
          },
        }),
    },
    {
      kind: "message",
      name: "natural language enters app create choice flow",
      text: "Create a feed dashboard app",
      responseIncludesAny: ["Picking next step..."],
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
      text: "Cancel the app create flow",
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
      name: "natural language edits a view",
      text: editFeedBoardInput,
      responseIncludesAny: ["Started view edit task for Feed Board"],
      assertTurn: (execution) =>
        expectRoutedAction(execution, {
          actionName: "VIEWS",
          parameters: {
            action: "edit",
            view: "feed-board",
            intent: "Make feed board show denser queue rows",
          },
          resultFields: {
            "values.mode": "edit",
            "values.viewId": "feed-board",
            "values.taskSessionId": "scenario-edit-view-feed-board",
          },
        }),
    },
    {
      kind: "message",
      name: "natural language edits an app",
      text: "Edit the feed app",
      responseIncludesAny: ["Started app edit task for Feed"],
      assertTurn: (execution) =>
        expectRoutedAction(execution, {
          actionName: "APP",
          parameters: {
            action: "create",
            editTarget: "feed",
            intent: "Tighten the feed app table density",
          },
          resultFields: {
            "values.mode": "create",
            "values.subMode": "edit",
            "values.name": "feed",
            "values.taskSessionId": "scenario-edit-app-feed",
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
      minCount: 4,
    },
    {
      type: "actionCalled",
      actionName: "APP",
      status: "success",
      minCount: 6,
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
            response: { body: launchResponse("run-feed-nl-2"), status: 200 },
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
            pathname: "/api/plugins/uninstall",
            response: {
              body: {
                ok: true,
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
