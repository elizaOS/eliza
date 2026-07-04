/**
 * Keyless coverage that view switching resolves across the navigable views in
 * every supported language. Runs on the pr-deterministic lane under the LLM proxy.
 */
import type {
  CapturedAction,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  CURATED_MULTILINGUAL,
  MATRIX_LANGUAGES,
} from "../../../../plugins/plugin-app-control/src/actions/view-matrix.fixtures";
import {
  jsonResponse,
  readAppControlHttpRequests,
  registerAppControlHttpHandler,
  resetAppControlHttpLoopback,
} from "./_helpers/app-control-http-loopback";

/**
 * Exhaustive deterministic scenario matrix (#8797, acceptance criterion 4).
 *
 * Drives the real VIEWS action across MANY navigable views in EVERY supported
 * language, using each view's curated fully-in-language navigation phrase as the
 * user text. Each turn supplies NO view option — the localized phrase is the
 * sole signal, so runViewsShow must RESOLVE the right view from the foreign-
 * language text (resolveIntentView/matchViewCommand) and then navigate (POST
 * /api/views/:id/navigate against the loopback). This proves end-to-end
 * multilingual routing, not just navigation. Zero LLM spend.
 *
 * The phrases come from the single source of truth
 * (plugins/plugin-app-control/src/actions/view-matrix.fixtures.ts:CURATED_MULTILINGUAL),
 * so the matrix can never silently drift from the matcher fixtures.
 */

type CoveredView = {
  id: string;
  label: string;
  path: string;
};

// The curated domain views covered by CURATED_MULTILINGUAL (calendar, wallet,
// inbox, settings), with the label + path the loopback registry serves. The
// VIEWS show handler echoes `label` back ("Navigated to <label> (gui).") and
// surfaces `data.view.path`, so these must match what the registry returns.
const COVERED_VIEWS: CoveredView[] = [
  { id: "calendar", label: "Calendar", path: "/apps/calendar" },
  { id: "wallet", label: "Wallet", path: "/apps/wallet" },
  { id: "inbox", label: "Inbox", path: "/apps/inbox" },
  { id: "settings", label: "Settings", path: "/settings" },
];

const COVERED_VIEW_BY_ID = new Map(
  COVERED_VIEWS.map((view) => [view.id, view]),
);

const registryViews = COVERED_VIEWS.map((view) => ({
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

// Every curated cell whose view we serve in the registry, one turn each:
// calendar/wallet/inbox/settings × 10 languages = 40 deterministic navigations.
const MATRIX_CASES = CURATED_MULTILINGUAL.filter((entry) =>
  COVERED_VIEW_BY_ID.has(entry.viewId),
);

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function expectShowTurn(
  execution: ScenarioTurnExecution,
  view: CoveredView,
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
  // No view option is supplied: the id below must be RESOLVED from the localized
  // phrase by runViewsShow (resolveIntentView). result.values.viewId being the
  // expected view proves the foreign-language text routed correctly.
  if (params.view !== undefined) {
    return `expected NO explicit view option (resolution must come from the localized text), saw view=${String(params.view)}`;
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
  id: "deterministic-view-switching-multilingual",
  lane: "pr-deterministic",
  title:
    "Deterministic view switching across navigable views in every language",
  domain: "scenario-runner",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "app-control",
    "views",
    "multilingual",
    "i18n",
  ],
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
      title: "Deterministic Multilingual View Switching",
    },
  ],
  // One action turn per curated cell: the localized user phrase is the ONLY
  // signal (no view option), so the VIEWS action must resolve the right view
  // from the foreign-language text and navigate — proving multilingual routing.
  turns: MATRIX_CASES.map((entry) => {
    const view = COVERED_VIEW_BY_ID.get(entry.viewId) as CoveredView;
    return {
      kind: "action" as const,
      name: `resolve ${view.id} from ${entry.lang}: "${entry.phrase}"`,
      text: entry.phrase,
      actionName: "VIEWS",
      options: { action: "show", viewType: "gui" },
      responseIncludesAny: [`Navigated to ${view.label}`],
      assertTurn: (execution: ScenarioTurnExecution) =>
        expectShowTurn(execution, view),
    };
  }),
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "VIEWS",
      status: "success",
      minCount: MATRIX_CASES.length,
    },
    {
      // No per-view "view":"<id>" arg: turns pass no view option, so each id is
      // resolved from the localized text (asserted per-turn via result.values
      // .viewId + the navigate-POST check below).
      type: "selectedActionArguments",
      actionName: "VIEWS",
      includesAll: [/"action":"show"/],
    },
    {
      type: "custom",
      name: "every covered view received a navigate request in every language",
      predicate: () => {
        const navigated = new Set(
          readAppControlHttpRequests()
            .filter((request) => request.method === "POST")
            .map((request) => NAVIGATE_PATTERN.exec(request.pathname)?.[1])
            .filter((id): id is string => typeof id === "string")
            .map((id) => decodeURIComponent(id)),
        );
        const missingViews = COVERED_VIEWS.map((view) => view.id).filter(
          (id) => !navigated.has(id),
        );
        if (missingViews.length > 0) {
          return `expected navigate requests for every covered view, missing: ${missingViews.join(", ")}; saw: ${[...navigated].join(", ") || "(none)"}`;
        }
        // Prove the matrix spanned every supported language for every view: a
        // covered view that lost a language cell would shrink MATRIX_CASES and
        // fail this exact-count check.
        const expected = COVERED_VIEWS.length * MATRIX_LANGUAGES.length;
        if (MATRIX_CASES.length !== expected) {
          return `expected ${expected} multilingual cells (${COVERED_VIEWS.length} views × ${MATRIX_LANGUAGES.length} languages), saw ${MATRIX_CASES.length}`;
        }
        return undefined;
      },
    },
  ],
});
