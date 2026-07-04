/**
 * Keyless coverage that the VIEWS action deep-links into a Settings subview. Runs
 * on the pr-deterministic lane under the LLM proxy.
 */
import type { ScenarioTurnExecution } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  jsonResponse,
  readAppControlHttpRequests,
  registerAppControlHttpHandler,
  resetAppControlHttpLoopback,
} from "./_helpers/app-control-http-loopback";

/**
 * Deterministic proof that the agent's VIEWS action can deep-link a Settings
 * *subview* — the slash<->agent parity gap from #9945. Each turn drives the real
 * VIEWS handler with action=show view=settings and a sub-section token (via the
 * `subview` param or its `section` alias), and we assert the navigate POST body
 * the renderer receives carries the *resolved* section id. Zero LLM spend.
 *
 * Resolution mirrors the client: `resolveSettingsSectionToken` maps a loose
 * token to a canonical section id (`model` -> `ai-model`), else the lowercased
 * token passes through. The live-lane analog (a real model discovering the
 * subview from the views provider prompt) is
 * `plugins/plugin-app-control/test/scenarios/settings-subview-deeplink.scenario.ts`.
 */

const SETTINGS_VIEW = {
  id: "settings",
  label: "Settings",
  viewType: "gui",
  description: "Settings view",
  path: "/settings",
  pluginName: "core",
  available: true,
  tags: ["settings"],
};

const NAVIGATE_PATTERN = /^\/api\/views\/([^/]+)\/navigate$/;

type SubviewCase = {
  name: string;
  /** Param the caller supplies (subview token or its `section` alias). */
  options: Record<string, unknown>;
  /** Resolved section id the navigate POST body must carry. */
  expectedSubview: string;
};

const SUBVIEW_CASES: SubviewCase[] = [
  {
    name: "voice subview (direct id)",
    options: { action: "show", view: "settings", subview: "voice" },
    expectedSubview: "voice",
  },
  {
    name: "model token resolves to ai-model",
    options: { action: "show", view: "settings", subview: "model" },
    expectedSubview: "ai-model",
  },
  {
    name: "security via the section alias param",
    options: { action: "show", view: "settings", section: "security" },
    expectedSubview: "security",
  },
];

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export default scenario({
  id: "deterministic-settings-subview",
  lane: "pr-deterministic",
  title: "Deterministic Settings subview deep-link via the VIEWS action",
  domain: "scenario-runner",
  tags: [
    "pr",
    "deterministic",
    "zero-cost",
    "app-control",
    "views",
    "settings",
  ],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-app-control"],
  },
  seed: [
    {
      type: "custom",
      name: "loopback /api/views registry + settings navigate endpoint",
      apply: () => {
        resetAppControlHttpLoopback();
        registerAppControlHttpHandler((request) => {
          if (request.method === "GET" && request.pathname === "/api/views") {
            return jsonResponse({ views: [SETTINGS_VIEW] });
          }
          const navigate = NAVIGATE_PATTERN.exec(request.pathname);
          if (request.method === "POST" && navigate) {
            const body = toRecord(request.body);
            return jsonResponse({
              ok: true,
              navigated: true,
              viewId: decodeURIComponent(navigate[1]),
              subview: body.subview,
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
      title: "Deterministic Settings Subview",
    },
  ],
  turns: SUBVIEW_CASES.map((subviewCase) => ({
    kind: "action" as const,
    name: subviewCase.name,
    text: `Open settings ${subviewCase.expectedSubview}`,
    actionName: "VIEWS",
    options: { ...subviewCase.options, viewType: "gui" },
    responseIncludesAny: ["Settings"],
    assertTurn: (execution: ScenarioTurnExecution): string | undefined => {
      const action = execution.actionsCalled.find(
        (candidate) => candidate.actionName === "VIEWS",
      );
      if (!action) {
        return `expected VIEWS action, saw ${execution.actionsCalled.map((c) => c.actionName).join(", ") || "none"}`;
      }
      if (action.result?.success !== true) {
        return `expected VIEWS result.success=true, saw ${JSON.stringify(action.result)}`;
      }
      return undefined;
    },
  })),
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "VIEWS",
      status: "success",
      minCount: SUBVIEW_CASES.length,
    },
    {
      type: "custom",
      name: "each settings navigate POST carried the resolved subview",
      predicate: () => {
        const navigatePosts = readAppControlHttpRequests().filter(
          (request) =>
            request.method === "POST" &&
            NAVIGATE_PATTERN.exec(request.pathname)?.[1] === "settings",
        );
        const seenSubviews = navigatePosts.map(
          (request) => toRecord(request.body).subview,
        );
        const expected = SUBVIEW_CASES.map((c) => c.expectedSubview);
        const missing = expected.filter((id) => !seenSubviews.includes(id));
        return missing.length === 0
          ? undefined
          : `expected navigate POST bodies with subview for ${expected.join(", ")}; missing ${missing.join(", ")}; saw ${seenSubviews.map(String).join(", ") || "(none)"}`;
      },
    },
  ],
});
