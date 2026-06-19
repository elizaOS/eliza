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

/**
 * End-to-end view-switching coverage for every built-in (first-party) view.
 * Each turn drives the real VIEWS action handler with action=show and an exact
 * `view` id, verifying the action resolves the view and actually navigates
 * (POST /api/views/:id/navigate against the loopback endpoint). Zero LLM spend.
 *
 * The proxy's utterance → exact (action, view) mapping is covered separately by
 * packages/test/mocks/__tests__/llm-proxy-plugin.test.ts. Here we prove the
 * action itself works for each navigable view.
 *
 * The `view` ids mirror the agent's BUILTIN_VIEWS registry
 * (packages/agent/src/api/builtin-views.ts) — keep them in sync so every
 * navigable first-party view has a deterministic e2e case.
 */

type BuiltinView = {
  id: string;
  label: string;
  path: string;
};

const BUILTIN_VIEWS: BuiltinView[] = [
  { id: "chat", label: "Chat", path: "/chat" },
  { id: "character", label: "Character", path: "/character" },
  { id: "automations", label: "Automations", path: "/automations" },
  { id: "plugins-page", label: "Plugins", path: "/apps/plugins" },
  { id: "trajectories", label: "Trajectories", path: "/apps/trajectories" },
  { id: "memories", label: "Memories", path: "/apps/memories" },
  { id: "database", label: "Database", path: "/apps/database" },
  { id: "logs", label: "Logs", path: "/apps/logs" },
  { id: "settings", label: "Settings", path: "/settings" },
];

const registryViews = BUILTIN_VIEWS.map((view) => ({
  id: view.id,
  label: view.label,
  viewType: "gui",
  description: `${view.label} view`,
  path: view.path,
  pluginName: "core",
  available: true,
  tags: [view.id],
}));

const NAVIGATE_PATTERN = /^\/api\/views\/([^/]+)\/navigate$/;

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function expectShowTurn(
  execution: ScenarioTurnExecution,
  view: BuiltinView,
): string | undefined {
  const expectedText = `Navigated to ${view.label} (gui).`;
  if (execution.responseText !== expectedText) {
    return `expected responseText=${JSON.stringify(expectedText)}, saw ${JSON.stringify(execution.responseText)}`;
  }
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "VIEWS",
  ) as CapturedAction | undefined;
  if (!action) {
    return `expected VIEWS action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`;
  }
  const params = toRecord(action.parameters);
  if (params.action !== "show") {
    return `expected VIEWS action=show, saw ${String(params.action)}`;
  }
  if (params.view !== view.id) {
    return `expected VIEWS view=${view.id}, saw ${String(params.view)}`;
  }
  if (action.result?.success !== true) {
    return `expected VIEWS result.success=true, saw ${JSON.stringify(action.result)}`;
  }
  const values = toRecord(action.result?.values);
  if (values.mode !== "show") {
    return `expected result.values.mode=show, saw ${String(values.mode)}`;
  }
  if (values.viewId !== view.id) {
    return `expected result.values.viewId=${view.id}, saw ${String(values.viewId)}`;
  }
  if (values.label !== view.label) {
    return `expected result.values.label=${view.label}, saw ${String(values.label)}`;
  }
  const data = toRecord(action.result?.data);
  const resolvedView = toRecord(data.view);
  if (resolvedView.path !== view.path) {
    return `expected result.data.view.path=${view.path}, saw ${String(resolvedView.path)}`;
  }
  return undefined;
}

export default scenario({
  id: "deterministic-view-switching",
  title: "Deterministic view switching across every built-in view",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "app-control", "views"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  seed: [
    {
      type: "custom",
      name: "loopback /api/views registry and per-view navigate endpoints",
      apply: () => {
        resetAppControlHttpLoopback();
        registerAppControlHttpHandler((request) => {
          if (request.method === "GET" && request.pathname === "/api/views") {
            return jsonResponse({ views: registryViews });
          }
          const navigate = NAVIGATE_PATTERN.exec(request.pathname);
          if (request.method === "POST" && navigate) {
            return jsonResponse({
              ok: true,
              navigated: true,
              viewId: decodeURIComponent(navigate[1]),
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
      title: "Deterministic View Switching",
    },
  ],
  turns: BUILTIN_VIEWS.map((view) => ({
    kind: "action",
    name: `show ${view.id} view`,
    text: `Open the ${view.label} view`,
    actionName: "VIEWS",
    options: { action: "show", view: view.id, viewType: "gui" },
    responseIncludesAny: [`Navigated to ${view.label}`],
    assertTurn: (execution: ScenarioTurnExecution) =>
      expectShowTurn(execution, view),
  })),
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "VIEWS",
      status: "success",
      minCount: BUILTIN_VIEWS.length,
    },
    {
      type: "selectedActionArguments",
      actionName: "VIEWS",
      includesAll: [
        /"action":"show"/,
        ...BUILTIN_VIEWS.map((view) => new RegExp(`"view":"${view.id}"`)),
      ],
    },
    {
      type: "custom",
      name: "every built-in view received a navigate request",
      predicate: () => {
        const navigated = new Set(
          readAppControlHttpRequests()
            .filter((request) => request.method === "POST")
            .map((request) => NAVIGATE_PATTERN.exec(request.pathname)?.[1])
            .filter((id): id is string => typeof id === "string")
            .map((id) => decodeURIComponent(id)),
        );
        const missing = BUILTIN_VIEWS.map((view) => view.id).filter(
          (id) => !navigated.has(id),
        );
        return missing.length === 0
          ? undefined
          : `expected navigate requests for every built-in view, missing: ${missing.join(", ")}; saw: ${[...navigated].join(", ") || "(none)"}`;
      },
    },
  ],
});
