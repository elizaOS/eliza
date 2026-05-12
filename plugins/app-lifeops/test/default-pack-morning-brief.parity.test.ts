/**
 * Parity test for the morning-brief default pack (W1-D).
 *
 * The morning-brief pack delegates assembly to `CheckinService.runMorningCheckin`
 * via the helper `buildMorningBriefPromptFromReport`. This test asserts byte
 * parity between the existing CHECKIN service's prompt builder
 * (`buildCheckinSummaryPrompt`) and the morning-brief pack's helper for the
 * same `Omit<CheckinReport, "summaryText">` input.
 *
 * Closes IMPL §3.4 verification:
 *   "Morning-brief pack's prompt + existing CHECKIN service's assembly logic
 *    produce parity content (fixture parity test)."
 */

import { describe, expect, it } from "vitest";
import { buildMorningBriefPromptFromReport } from "../src/default-packs/morning-brief.js";
import { buildCheckinSummaryPrompt } from "../src/lifeops/checkin/checkin-service.js";
import type { CheckinReport } from "../src/lifeops/checkin/types.js";

function buildFixtureReport(): Omit<CheckinReport, "summaryText"> {
  return {
    reportId: "fixture-morning-001",
    kind: "morning",
    generatedAt: "2026-01-15T07:00:00.000Z",
    escalationLevel: 0,
    overdueTodos: [
      { id: "t1", title: "draft launch announcement", dueAt: "2026-01-14T17:00:00.000Z" },
      { id: "t2", title: "respond to investor follow-ups", dueAt: null },
    ],
    todaysMeetings: [
      {
        id: "evt1",
        title: "engineering standup",
        startAt: "2026-01-15T15:00:00.000Z",
        endAt: "2026-01-15T15:30:00.000Z",
      },
    ],
    yesterdaysWins: [
      { id: "w1", title: "shipped CDN cache fix", completedAt: "2026-01-14T22:30:00.000Z" },
    ],
    habitSummaries: [
      {
        definitionId: "habit-water",
        title: "Drink water",
        kind: "habit",
        currentOccurrenceStreak: 3,
        bestOccurrenceStreak: 7,
        missedOccurrenceStreak: 0,
        pauseUntil: null,
        isPaused: false,
      },
    ],
    habitEscalationLevel: 0,
    briefingSections: [
      {
        key: "inbox",
        title: "Inbox",
        summary: "Inbox channels scanned: gmail: 3/2 unread.",
        items: [],
        error: null,
      },
    ],
    sleepRecap: null,
    collectorErrors: {
      overdueTodos: null,
      todaysMeetings: null,
      yesterdaysWins: null,
    },
  };
}

describe("morning-brief default pack ↔ CheckinService prompt parity", () => {
  it("produces byte-identical prompt text for the morning-fixture report", () => {
    const report = buildFixtureReport();
    const fromCheckinService = buildCheckinSummaryPrompt(report);
    const fromDefaultPack = buildMorningBriefPromptFromReport({
      ...report,
      kind: "morning",
    });
    expect(fromDefaultPack).toEqual(fromCheckinService);
  });

  it("includes the morning intro line", () => {
    const report = buildFixtureReport();
    const prompt = buildMorningBriefPromptFromReport({ ...report, kind: "morning" });
    expect(prompt.startsWith("Write the owner's morning")).toBe(true);
  });

  it("does not include night-only sleep recap section for morning reports", () => {
    const report = buildFixtureReport();
    const prompt = buildMorningBriefPromptFromReport({ ...report, kind: "morning" });
    expect(prompt).not.toContain("Sleep recap (use these facts only");
  });

  it("preserves the embedded JSON report payload", () => {
    const report = buildFixtureReport();
    const prompt = buildMorningBriefPromptFromReport({ ...report, kind: "morning" });
    expect(prompt).toContain('"reportId":"fixture-morning-001"');
    expect(prompt).toContain('"kind":"morning"');
  });
});
