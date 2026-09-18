/**
 * Reporting-path integration test for the window-title PII redactor boundary.
 * Real PGlite runtime via createLifeOpsTestRuntime: legacy-shaped event rows
 * (with RAW window titles, as written by pre-privacy hosts — the current
 * repository pins window_title to NULL on new writes) are inserted via the
 * raw SQL seam, read back through the real listActivityEvents query, and
 * aggregated by the real getActivityReportBetween — the exact path that
 * emits sampleWindowTitles to activity-report consumers. Pins that raw card
 * digits (any Unicode decimal script) never leave the process in the
 * emitted report while benign controls (timestamps, room numbers, phone-
 * shaped US numbers under the CC floor) remain readable. The reporting
 * path logs no window titles (verified: no logger call in the reporting,
 * repo, or redactor modules references a title), so the emitted report
 * artifact is the sole egress surface. Integration-backed (real PGlite);
 * no mocks of the reporting or repo layers.
 */
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { executeRawSql, sqlQuote, sqlText } from "../lifeops/sql.js";
import { getActivityReportBetween } from "./activity-tracker-reporting.js";

const agentId = "activity-redactor-reporting-agent";

/**
 * Inserts a legacy-shaped activity event row carrying a RAW window title.
 * Current repository writes never persist titles (insertActivityEvent pins
 * window_title to NULL); redaction in getActivityReportBetween is the
 * privacy boundary for titles that DO exist in rows written before that
 * posture (or by older hosts) — exactly the population this test must
 * cover, so the row is inserted with the raw SQL seam the legacy path used.
 */
async function insertLegacyTitleEvent(
  runtime: AgentRuntime,
  observedAtMs: number,
  bundleId: string,
  appName: string,
  windowTitle: string,
): Promise<void> {
  const id = `legacy-${bundleId}-${observedAtMs}`;
  await executeRawSql(
    runtime,
    `INSERT INTO app_lifeops.life_activity_events (
      id, agent_id, observed_at, event_kind, bundle_id, app_name,
      window_title, metadata_json, created_at
    ) VALUES (
      ${sqlQuote(id)},
      ${sqlQuote(agentId)},
      ${sqlQuote(new Date(observedAtMs).toISOString())},
      'activate',
      ${sqlQuote(bundleId)},
      ${sqlQuote(appName)},
      ${sqlText(windowTitle)},
      ${sqlQuote("{}")},
      ${sqlQuote(new Date(observedAtMs).toISOString())}
    )`,
  );
  await executeRawSql(
    runtime,
    `INSERT INTO app_lifeops.life_activity_events (
      id, agent_id, observed_at, event_kind, bundle_id, app_name,
      window_title, metadata_json, created_at
    ) VALUES (
      ${sqlQuote(`${id}-off`)},
      ${sqlQuote(agentId)},
      ${sqlQuote(new Date(observedAtMs + 60_000).toISOString())},
      'deactivate',
      ${sqlQuote(bundleId)},
      ${sqlQuote(appName)},
      ${sqlText(null)},
      ${sqlQuote("{}")},
      ${sqlQuote(new Date(observedAtMs).toISOString())}
    )`,
  );
}

// Card-shaped values a real browser title carries. Each must leave the
// process as [redacted-cc] — no raw digit substring may survive in the
// emitted report.
const panTitles: Array<[name: string, title: string]> = [
  ["16-digit contiguous PAN", "Card 4111111111111111 - Bank"],
  ["16-digit PAN spaced in 4s", "Card 4111 1111 1111 1111 - Bank"],
  [
    "12-digit PAN (ISO/IEC 7812 floor, reviewer example)",
    "Card 501234567890 - Bank",
  ],
  ["12-digit PAN with NBSP separators", "Card 5012\u00A03456\u00A07890 - Bank"],
  ["13-digit run", "ref 1234567890123 ok"],
  ["19-digit run", "ref 1234567890123456789 ok"],
  [">19-digit run (PAN + expiry concat)", "Card 4111 1111 1111 1111/2024"],
  ["localized Arabic-Indic PAN", "Bank ٤١١١ ١١١١ ١١١١ ١١١١ stmt"],
  ["fullwidth PAN", "Bank ４１１１－１１１１－１１１１－１１１１ stmt"],
];

describe("activity report redaction — real PGlite reporting path", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  const t0 = Date.parse("2027-05-04T09:00:00.000Z");
  const minuteMs = 60_000;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
  });

  afterAll(async () => {
    await runtimeResult.cleanup();
  });

  it("emits no raw PAN digits in sampleWindowTitles for every card-shaped title class", async () => {
    let cursor = t0;
    for (const [_name, title] of panTitles) {
      await insertLegacyTitleEvent(
        runtime,
        cursor,
        "com.redactor.probe",
        "Probe",
        title,
      );
      cursor += 2 * minuteMs;
    }
    const report = await getActivityReportBetween(runtime, agentId, {
      sinceMs: t0,
      untilMs: cursor,
    });
    expect(report.apps).toHaveLength(1);
    const titles = report.apps[0]?.sampleWindowTitles ?? [];
    // aggregateByApp dedupes titles through a Set, and redaction collapses
    // the 9 raw classes into exactly 4 unique redacted forms — pin that
    // exact set so any leak (a 5th, digit-bearing title) or any over-
    // redaction shape change is caught.
    expect(titles).toHaveLength(4);
    expect(new Set(titles)).toEqual(
      new Set([
        "Card [redacted-cc] - Bank",
        "ref [redacted-cc] ok",
        "Card [redacted-cc]",
        "Bank [redacted-cc] stmt",
      ]),
    );
    // No raw card digit run survives in ANY decimal script (ASCII,
    // Arabic-Indic, fullwidth): strip the placeholder tokens and no
    // 4+-digit \p{Nd} sequence (the longest benign control in this corpus
    // is "Room 42") may remain.
    for (const title of titles) {
      const residual = title.replaceAll("[redacted-cc]", "");
      expect(residual).not.toMatch(/\p{Nd}{4}/u);
    }
  });

  it("keeps benign controls readable in the same report", async () => {
    // Written in a second bundle so both assertions cover real emitted
    // reports. Benign classes: timestamps, small room/building numbers, a
    // 7-digit phone extension, and a normal prose title — none is
    // card-shaped; all must survive redaction unchanged.
    const benign: Array<[name: string, title: string, expected: string]> = [
      ["timestamp", "Meet at 14:30 (room 42)", "Meet at 14:30 (room 42)"],
      ["7-digit extension", "Call ext 4960148", "Call ext 4960148"],
      [
        "prose title",
        "eliza - redactor.ts - elizaOS",
        "eliza - redactor.ts - elizaOS",
      ],
      [
        "US phone (10 digits)",
        "Call (415) 496-0148 back",
        "Call [redacted-phone] back",
      ],
    ];
    let cursor = t0 + 24 * 60 * minuteMs;
    for (const [_name, title, _expected] of benign) {
      await insertLegacyTitleEvent(
        runtime,
        cursor,
        "com.redactor.benign",
        "Benign",
        title,
      );
      cursor += 2 * minuteMs;
    }
    const report = await getActivityReportBetween(runtime, agentId, {
      sinceMs: t0 + 23 * 60 * minuteMs,
      untilMs: cursor,
    });
    const app = report.apps.find((a) => a.bundleId === "com.redactor.benign");
    expect(app).toBeDefined();
    const titles = app?.sampleWindowTitles ?? [];
    expect(titles).toHaveLength(benign.length);
    expect(titles).toContain("Meet at 14:30 (room 42)");
    expect(titles).toContain("Call ext 4960148");
    expect(titles).toContain("eliza - redactor.ts - elizaOS");
    expect(titles).toContain("Call [redacted-phone] back");
  });
});
