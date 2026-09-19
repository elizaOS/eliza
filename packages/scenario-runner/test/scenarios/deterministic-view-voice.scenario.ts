/**
 * Exercises structured navigation authority against bare voice transcripts.
 * Direct action turns bypass planning: rejection and HTTP effects are covered,
 * while natural-language destination selection requires a live planner scenario.
 */
import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  jsonResponse,
  readAppControlHttpRequests,
  registerAppControlHttpHandler,
  resetAppControlHttpLoopback,
} from "./_helpers/app-control-http-loopback";

const inputs = [
  "settings",
  "calendar",
  "wallet",
  "inbox",
  "todos",
  "documents",
  "contacts",
  "health",
].map((text) => ({ name: text, text }));
const views = [
  { id: "settings", label: "Settings", path: "/settings" },
  { id: "calendar", label: "Calendar", path: "/apps/calendar" },
];
const navigatePattern = /^\/api\/views\/([^/]+)\/navigate$/;
function navigations(): string[] {
  return readAppControlHttpRequests().flatMap((request) => {
    const match = navigatePattern.exec(request.pathname);
    return request.method === "POST" && match
      ? [decodeURIComponent(match[1])]
      : [];
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function rejected(execution: ScenarioTurnExecution): string | undefined {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "VIEWS",
  );
  const result = record(action?.result);
  const navigation = record(record(result.data).navigation);
  if (
    !action ||
    record(action.parameters).view !== undefined ||
    result.success !== false ||
    record(result.raw).turnComplete !== false ||
    record(result.raw).transcriptVisibility !== "internal" ||
    navigation.status !== "invalid" ||
    navigation.viewId !== null
  ) {
    return "Missing structured destination must yield an internal invalid navigation result without completing the turn";
  }
  if (navigations().length !== 0)
    return "Request prose navigated without a structured destination";
  return undefined;
}
function accepted(execution: ScenarioTurnExecution): string | undefined {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === "VIEWS",
  );
  const result = record(action?.result);
  const values = record(result.values);
  const view = record(record(result.data).view);
  if (
    !action ||
    record(action.parameters).view !== "settings" ||
    result.success !== true ||
    record(result.raw).transcriptVisibility !== "internal" ||
    values.viewId !== "settings" ||
    view.path !== "/settings"
  ) {
    return "Conflicting prose must not replace the structured Settings destination or its internal receipt";
  }
  if (JSON.stringify(navigations()) !== JSON.stringify(["settings"])) {
    return "Expected exactly one Settings navigation and no prose-selected destination";
  }
  return undefined;
}
export default scenario({
  id: "deterministic-view-voice",
  lane: "pr-deterministic",
  title: "Structured navigation authority with bare voice transcripts",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "app-control", "views", "voice"],
  isolation: "shared-runtime",
  requires: { plugins: ["@elizaos/plugin-app-control"] },
  seed: [
    {
      type: "custom",
      name: "loopback registry and captured navigation effects",
      apply: () => {
        resetAppControlHttpLoopback();
        registerAppControlHttpHandler((request) => {
          if (request.method === "GET" && request.pathname === "/api/views") {
            return jsonResponse({
              views: views.map((view) => ({
                ...view,
                viewType: "gui",
                description: view.label,
                pluginName: "core",
                available: true,
                tags: [view.id],
              })),
            });
          }
          const match = navigatePattern.exec(request.pathname);
          if (request.method === "POST" && match) {
            return jsonResponse({
              ok: true,
              navigated: true,
              viewId: decodeURIComponent(match[1]),
            });
          }
          return undefined;
        });
        return undefined;
      },
    },
  ],
  rooms: [
    { id: "main", source: "chat", title: "Structured navigation boundary" },
  ],
  turns: [
    ...inputs.map((input) => ({
      kind: "action" as const,
      name: `reject unstructured ${input.name}`,
      text: input.text,
      actionName: "VIEWS",
      options: { action: "show", viewType: "gui" },
      assertTurn: rejected,
    })),
    {
      kind: "action",
      name: "structured destination owns navigation despite conflicting prose",
      text: "calendar",
      actionName: "VIEWS",
      options: { action: "show", view: "settings", viewType: "gui" },
      assertTurn: accepted,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "only the explicitly selected destination received a navigation",
      predicate: () =>
        JSON.stringify(navigations()) === JSON.stringify(["settings"])
          ? undefined
          : "Unexpected navigation effect outside the explicit structured target",
    },
  ],
});
