/**
 * Screen-time on multi-monitor + incognito.
 *
 * The user has two displays. Two browser focus windows on display A
 * (`github.com`, `docs.google.com`) and one on display B
 * (`meet.google.com`). One incognito tab is registered with NO focus
 * window data because the extension cannot read incognito (per
 * browser-extension-store contract).
 *
 * The agent must:
 *   - report the multi-monitor totals truthfully (sum of focus minutes)
 *   - explicitly mark incognito as opaque / unmeasured
 *
 * Failure modes:
 *   - reporting 0 minutes for incognito and silently calling it "no usage"
 *   - dropping display B because of single-display assumptions
 *   - inflating the total to include a fabricated incognito estimate
 *
 * Cited: 03-coverage-gap-matrix.md row 58 — daily report scenario exists
 * but multi-monitor + incognito edge has no scenario.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import {
  judgeRubric,
} from "../_helpers/action-assertions.ts";
import { seedBrowserExtensionTelemetry } from "../_helpers/lifeops-seeds.ts";
import {
  recordBrowserSessionRegistration,
} from "../../../plugins/app-lifeops/src/lifeops/browser-extension-store.ts";

function checkScreenTimeReportIsHonest(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty agent response";

  // The seeded telemetry: github.com (display A, 30m), docs.google.com (display A, 20m),
  // meet.google.com (display B, 25m). Total measurable time = 75m.
  // Incognito provides no focus windows.
  const measurableHosts = ["github.com", "docs.google.com", "meet.google.com"];
  const missing = measurableHosts.filter((h) => !reply.includes(h));
  if (missing.length > 0) {
    return `Agent's screen-time report did not surface every display's measured site. Missing: ${missing.join(", ")}. Reply: ${reply.slice(0, 400)}`;
  }
  // Incognito honesty: the reply must contain a marker that incognito is
  // unmeasured / opaque. The user did NOT use the word incognito in the
  // prompt, so a hit proves the agent surfaced it from the extension state.
  const incognitoMarkers = [
    "incognito",
    "private browsing",
    "private window",
    "opaque",
    "can't see",
    "cannot see",
    "not visible",
    "unmeasured",
    "no telemetry",
    "extension can't",
    "extension cannot",
  ];
  if (!incognitoMarkers.some((m) => reply.includes(m))) {
    return `Agent did not flag the incognito session as opaque/unmeasured. The user has an active incognito session that the extension cannot inspect. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "screen-time.multi-monitor-incognito",
  title:
    "Screen-time report covers multiple displays AND flags incognito as opaque",
  domain: "browser.lifeops",
  tags: [
    "lifeops",
    "browser",
    "screen-time",
    "multi-monitor",
    "incognito",
    "robustness",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Screen-Time Multi-Monitor Incognito",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-display-a-focus-windows",
      apply: seedBrowserExtensionTelemetry({
        deviceId: "browser-display-a",
        browserVendor: "chrome",
        windows: [
          {
            url: "https://github.com/elizaOS/eliza",
            offsetMinutes: 0,
            durationMinutes: 30,
          },
          {
            url: "https://docs.google.com/document/d/abc",
            offsetMinutes: 35,
            durationMinutes: 20,
          },
        ],
      }),
    },
    {
      type: "custom",
      name: "seed-display-b-focus-windows",
      apply: seedBrowserExtensionTelemetry({
        deviceId: "browser-display-b",
        browserVendor: "chrome",
        windows: [
          {
            url: "https://meet.google.com/abc-defg-hij",
            offsetMinutes: 60,
            durationMinutes: 25,
          },
        ],
      }),
    },
    {
      type: "custom",
      name: "seed-incognito-session-no-focus-windows",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        // Register the session with `incognito: true` shape but never call
        // recordBrowserFocusWindow — the extension cannot send focus data
        // for incognito tabs.
        await recordBrowserSessionRegistration(runtime, {
          deviceId: "browser-incognito-1",
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X) AgentBrowserBridge/1.0 incognito",
          extensionVersion: "1.0.0",
          browserVendor: "chrome",
          registeredAt: new Date().toISOString(),
        });
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-multi-display-screen-time",
      room: "main",
      text: "What sites have I been on this morning across all my displays?",
      expectedActions: ["SCREEN_TIME"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "SCREEN_TIME",
      minCount: 1,
    },
    {
      type: "custom",
      name: "report-covers-both-displays-and-flags-incognito",
      predicate: checkScreenTimeReportIsHonest,
    },
    judgeRubric({
      name: "screen-time-multi-monitor-incognito-rubric",
      threshold: 0.7,
      description: `The user has telemetry from TWO displays (github.com + docs.google.com on display A, meet.google.com on display B) AND one active incognito session that the extension cannot inspect. A correct reply: lists all three measured sites (or at minimum acknowledges activity on multiple displays) AND explicitly notes that incognito browsing is opaque to the extension / cannot be measured. An incorrect reply: returns activity from only one display; ignores incognito entirely (silently treating it as zero usage); or fabricates incognito activity. Score 0 if incognito is not acknowledged AND the reply omits any of the three measured sites.`,
    }),
  ],
});
