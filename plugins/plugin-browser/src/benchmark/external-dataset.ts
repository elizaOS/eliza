/**
 * External-dataset benchmark fixtures for #10333.
 *
 * This is intentionally small and committed in-repo: CI can gate the adapter
 * without downloading the full Mind2Web/WebArena corpora. Each row mirrors the
 * external benchmark shape (site, start URL, natural-language goal, DOM routes,
 * action trace, and observable reward checks), including Mind2Web's CLICK /
 * TYPE / SELECT operation mix, then compiles into the same BenchmarkTask
 * contract used by the MiniWoB lane. Execution still goes through
 * BrowserBenchmarkAdapter -> real BROWSER commands.
 */

import type {
  BenchmarkAction,
  BenchmarkRewardContext,
  BenchmarkTask,
} from "./types.js";

export const EXTERNAL_DATASET_ORIGIN = "https://external-benchmark.test";

export type ExternalDatasetFamily = "mind2web-lite" | "webarena-lite";

export interface ExternalDatasetRoute {
  url: string;
  html: string;
}

export interface ExternalDatasetRewardCheck {
  type: "url" | "value" | "checked" | "text";
  selector?: string;
  equals: string | boolean;
}

export interface ExternalDatasetRecord {
  id: string;
  family: ExternalDatasetFamily;
  sourceDataset: "Mind2Web" | "WebArena";
  site: string;
  description: string;
  goal: string;
  startUrl: string;
  routes: readonly ExternalDatasetRoute[];
  trace: readonly BenchmarkAction[];
  reward: readonly ExternalDatasetRewardCheck[];
  maxSteps: number;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html>
  <head><title>${escapeHtml(title)}</title></head>
  <body>${body}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const travelStart = `${EXTERNAL_DATASET_ORIGIN}/travel/search`;
const supportStart = `${EXTERNAL_DATASET_ORIGIN}/support`;
const supportReturns = `${EXTERNAL_DATASET_ORIGIN}/support/returns`;
const adminStart = `${EXTERNAL_DATASET_ORIGIN}/admin`;

export const EXTERNAL_WEB_DATASET_FIXTURE: readonly ExternalDatasetRecord[] = [
  {
    id: "mind2web-travel-search",
    family: "mind2web-lite",
    sourceDataset: "Mind2Web",
    site: "travel",
    description: "Fill a travel search form from a natural-language goal.",
    goal: "Search for an economy flight from SFO to JFK on 2026-07-14 and include flexible dates.",
    startUrl: travelStart,
    routes: [
      {
        url: travelStart,
        html: page(
          "Travel Search",
          `<div id="task">Search for an economy flight from SFO to JFK on 2026-07-14 and include flexible dates.</div>
<label>From <input id="from" name="from" value="" /></label>
<label>To <input id="to" name="to" value="" /></label>
<label>Date <input id="date" name="date" value="" /></label>
<label>Cabin <select id="cabin" name="cabin">
  <option value="">Choose cabin</option>
  <option value="economy">Economy</option>
  <option value="business">Business</option>
</select></label>
<label><input id="flexible" type="checkbox" /> Flexible dates</label>
<button id="search" type="button">Search</button>`,
        ),
      },
    ],
    trace: [
      { type: "fill", selector: "#from", value: "SFO", note: "origin" },
      { type: "fill", selector: "#to", value: "JFK", note: "destination" },
      { type: "fill", selector: "#date", value: "2026-07-14", note: "date" },
      { type: "select", selector: "#cabin", value: "economy", note: "cabin" },
      { type: "check", selector: "#flexible", note: "flexible dates" },
      { type: "click", selector: "#search", note: "submit search" },
    ],
    reward: [
      { type: "value", selector: "#from", equals: "SFO" },
      { type: "value", selector: "#to", equals: "JFK" },
      { type: "value", selector: "#date", equals: "2026-07-14" },
      { type: "value", selector: "#cabin", equals: "economy" },
      { type: "checked", selector: "#flexible", equals: true },
    ],
    maxSteps: 8,
  },
  {
    id: "mind2web-support-return",
    family: "mind2web-lite",
    sourceDataset: "Mind2Web",
    site: "support",
    description:
      "Navigate to a support return form and complete required fields.",
    goal: "Open returns, enter order A-1042, and confirm the prepaid label request.",
    startUrl: supportStart,
    routes: [
      {
        url: supportStart,
        html: page(
          "Support Home",
          `<div id="task">Open returns, enter order A-1042, and confirm the prepaid label request.</div>
<a id="returns-link" href="/support/returns">Returns</a>
<a id="warranty-link" href="/support/warranty">Warranty</a>`,
        ),
      },
      {
        url: supportReturns,
        html: page(
          "Returns",
          `<label>Order <input id="order-id" value="" /></label>
<label><input id="prepaid-label" type="checkbox" /> Request prepaid label</label>
<button id="submit-return" type="button">Submit</button>`,
        ),
      },
    ],
    trace: [
      { type: "click", selector: "#returns-link", note: "open returns" },
      {
        type: "fill",
        selector: "#order-id",
        value: "A-1042",
        note: "order id",
      },
      { type: "check", selector: "#prepaid-label", note: "prepaid label" },
      { type: "click", selector: "#submit-return", note: "submit return" },
    ],
    reward: [
      { type: "url", equals: supportReturns },
      { type: "value", selector: "#order-id", equals: "A-1042" },
      { type: "checked", selector: "#prepaid-label", equals: true },
    ],
    maxSteps: 6,
  },
  {
    id: "webarena-admin-invite",
    family: "webarena-lite",
    sourceDataset: "WebArena",
    site: "admin",
    description: "Complete a realistic admin invitation workflow.",
    goal: "Invite robin@example.com as an administrator and send the welcome email.",
    startUrl: adminStart,
    routes: [
      {
        url: adminStart,
        html: page(
          "Admin Users",
          `<div id="task">Invite robin@example.com as an administrator and send the welcome email.</div>
<label>Email <input id="invite-email" value="" /></label>
<label><input id="admin-role" type="checkbox" /> Administrator</label>
<label><input id="send-welcome" type="checkbox" /> Send welcome email</label>
<button id="invite" type="button">Invite</button>`,
        ),
      },
    ],
    trace: [
      {
        type: "fill",
        selector: "#invite-email",
        value: "robin@example.com",
        note: "invite email",
      },
      { type: "check", selector: "#admin-role", note: "admin role" },
      { type: "check", selector: "#send-welcome", note: "welcome email" },
      { type: "click", selector: "#invite", note: "send invite" },
    ],
    reward: [
      { type: "value", selector: "#invite-email", equals: "robin@example.com" },
      { type: "checked", selector: "#admin-role", equals: true },
      { type: "checked", selector: "#send-welcome", equals: true },
    ],
    maxSteps: 6,
  },
];

export function externalDatasetRecordToTask(
  record: ExternalDatasetRecord,
): BenchmarkTask {
  return {
    id: record.id,
    family: record.family,
    description: `${record.sourceDataset} fixture: ${record.description}`,
    maxSteps: record.maxSteps,
    utterance() {
      return record.goal;
    },
    build() {
      return {
        startUrl: record.startUrl,
        routes: record.routes,
      };
    },
    oracle() {
      return [...record.trace];
    },
    reward(ctx) {
      return scoreExternalReward(ctx, record.reward);
    },
  };
}

async function scoreExternalReward(
  ctx: BenchmarkRewardContext,
  checks: readonly ExternalDatasetRewardCheck[],
): Promise<number> {
  for (const check of checks) {
    if (check.type === "url") {
      if ((await ctx.getUrl()) !== check.equals) return 0;
      continue;
    }
    if (!check.selector) return 0;
    if (check.type === "value") {
      if ((await ctx.getValue(check.selector)) !== check.equals) return 0;
    } else if (check.type === "checked") {
      if ((await ctx.getChecked(check.selector)) !== check.equals) return 0;
    } else if ((await ctx.getText(check.selector)) !== check.equals) {
      return 0;
    }
  }
  return 1;
}

export const EXTERNAL_WEB_DATASET_TASKS: readonly BenchmarkTask[] =
  EXTERNAL_WEB_DATASET_FIXTURE.map(externalDatasetRecordToTask);
