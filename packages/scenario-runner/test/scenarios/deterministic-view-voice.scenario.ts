/**
 * Keyless coverage of per-view voice-transcript navigation. Runs on the
 * pr-deterministic lane under the LLM proxy.
 */
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
 * Per-view voice-transcript coverage (#8797, acceptance criterion 5).
 *
 * A voice pass yields a short, bare, lowercase transcript with no punctuation —
 * "settings", "calendar", "wallet". The live `views-voice-navigate` case
 * (plugins/plugin-app-control/test/scenarios/views-voice-navigate.scenario.ts)
 * proves the planner routes one such phrase ("settings") to the VIEWS action.
 * This deterministic (pr lane, no LLM) scenario extends that single case to many
 * views: each turn carries ONLY a bare voice noun (no view option), so the real
 * VIEWS action must RESOLVE the noun to a view itself (resolveIntentView /
 * matchViewCommand) and then navigate (POST /api/views/:id/navigate against the
 * loopback endpoint). The noun is load-bearing — a resolver regression makes the
 * action navigate to the wrong view (or none) and the per-turn check fails.
 * Zero LLM spend.
 *
 * The `voice noun → exact view id` mapping is the rigid matcher's
 * (`matchViewCommand` in plugins/plugin-app-control/src/actions/view-command-matcher.ts):
 * bare nouns "settings"/"calendar"/"wallet"/"inbox"/"todos"/"documents"/"health"
 * resolve to the like-named view, and "contacts" resolves to the `relationships`
 * view. Every view id below has a matcher noun (verified against
 * view-command-matcher.ts) and is a real navigable view. We deliberately do NOT
 * cover "phone": no view nor matcher noun exists for it, so a voice "phone"
 * transcript has no deterministic target.
 */

type VoiceView = {
  // Bare, lowercase, punctuation-free transcript as a voice pass produces it.
  noun: string;
  // View id the rigid matcher resolves `noun` to (matchViewCommand).
  id: string;
  label: string;
  path: string;
};

const VOICE_VIEWS: VoiceView[] = [
  { noun: "settings", id: "settings", label: "Settings", path: "/settings" },
  {
    noun: "calendar",
    id: "calendar",
    label: "Calendar",
    path: "/apps/calendar",
  },
  { noun: "wallet", id: "wallet", label: "Wallet", path: "/apps/wallet" },
  { noun: "inbox", id: "inbox", label: "Inbox", path: "/apps/inbox" },
  { noun: "todos", id: "todos", label: "Todos", path: "/apps/todos" },
  {
    noun: "documents",
    id: "documents",
    label: "Documents",
    path: "/apps/documents",
  },
  // Voice "contacts" → the relationships view (matcher noun synonym).
  {
    noun: "contacts",
    id: "relationships",
    label: "Relationships",
    path: "/apps/relationships",
  },
  { noun: "health", id: "health", label: "Health", path: "/apps/health" },
];

const registryViews = VOICE_VIEWS.map((view) => ({
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

function expectVoiceTurn(
  execution: ScenarioTurnExecution,
  view: VoiceView,
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
  // The turn supplies NO view option — the view id below must be RESOLVED from
  // the bare voice transcript by runViewsShow (resolveIntentView). result.values
  // .viewId being correct proves the voice noun routed to the right view, not
  // that we handed the id to the action. (params.view is intentionally unset.)
  if (params.view !== undefined) {
    return `expected NO explicit view option (resolution must come from voice text), saw view=${String(params.view)}`;
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
  id: "deterministic-view-voice",
  lane: "pr-deterministic",
  title: "Deterministic per-view voice-transcript navigation",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "app-control", "views", "voice"],
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
      source: "chat",
      title: "Deterministic View Voice",
    },
  ],
  // Each turn's text is the bare voice noun a transcription pass yields; the
  // action navigates to the view that noun deterministically resolves to.
  turns: VOICE_VIEWS.map((view) => ({
    kind: "action",
    name: `voice "${view.noun}" → ${view.id} view`,
    // The bare voice noun is the ONLY signal — no view option. runViewsShow must
    // resolve it (resolveIntentView/matchViewCommand) to the right view id.
    text: view.noun,
    actionName: "VIEWS",
    options: { action: "show", viewType: "gui" },
    responseIncludesAny: [`Navigated to ${view.label}`],
    assertTurn: (execution: ScenarioTurnExecution) =>
      expectVoiceTurn(execution, view),
  })),
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "VIEWS",
      status: "success",
      minCount: VOICE_VIEWS.length,
    },
    {
      // No per-view "view":"<id>" arg here on purpose: the turns pass no view
      // option, so the id is resolved from the voice text (asserted per-turn via
      // result.values.viewId + the navigate-POST check below).
      type: "selectedActionArguments",
      actionName: "VIEWS",
      includesAll: [/"action":"show"/],
    },
    {
      type: "custom",
      name: "every voice-noun view received a navigate request",
      predicate: () => {
        const navigated = new Set(
          readAppControlHttpRequests()
            .filter((request) => request.method === "POST")
            .map((request) => NAVIGATE_PATTERN.exec(request.pathname)?.[1])
            .filter((id): id is string => typeof id === "string")
            .map((id) => decodeURIComponent(id)),
        );
        const missing = VOICE_VIEWS.map((view) => view.id).filter(
          (id) => !navigated.has(id),
        );
        return missing.length === 0
          ? undefined
          : `expected navigate requests for every voice-noun view, missing: ${missing.join(", ")}; saw: ${[...navigated].join(", ") || "(none)"}`;
      },
    },
  ],
});
