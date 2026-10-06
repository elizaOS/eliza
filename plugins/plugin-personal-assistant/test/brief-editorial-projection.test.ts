/** Rendering consumes editorial decisions, not the engagement history that produced them. */
import { describe, expect, it } from "vitest";
import { buildNarrativePrompt } from "../src/actions/brief.ts";
import { buildBriefEditorialContract } from "../src/lifeops/briefing/editorial-judgment.ts";
import type { LifeOpsBriefingSections } from "../src/types/briefing.ts";

const asOf = "2026-10-06T02:00:00.000Z";
const engagementSummaries = [
  {
    itemClass: "life:reminder",
    renderedCount: 5,
    ignoredCount: 5,
    actedOnCount: 0,
    lastEventAt: asOf,
    lastDemotedAt: null,
    lastRestoredAt: null,
  },
];

describe("brief editorial rendering projection", () => {
  it("encodes complete typed data compactly without changing Unicode, escapes or source scope", () => {
    const sections: LifeOpsBriefingSections = {
      calendar: [
        {
          id: 'calendar:"雪"\\id',
          title: 'Café 🛰️\n"Quoted" \\ path',
          startAt: "2026-10-06T03:00:00.000Z",
          endAt: "2026-10-06T03:15:00.000Z",
        },
      ],
      life: [
        {
          id: "reminder-exact",
          kind: "reminder",
          title: "First line\nSecond line\t<not-markup>",
          state: "visible",
          dueAt: "2026-10-06T01:00:00.000Z",
        },
      ],
      commitments: [],
    };
    const sourceErrors = { inbox: "not_connected" as const };
    const lifeSummary = {
      activeOccurrenceCount: 1,
      overdueOccurrenceCount: 1,
      snoozedOccurrenceCount: 0,
      activeReminderCount: 1,
      activeGoalCount: 0,
    };
    const editorial = buildBriefEditorialContract({
      sections,
      engagementSummaries: [],
    });
    const before = structuredClone({
      sections,
      sourceErrors,
      lifeSummary,
      editorial,
    });
    const prompt = buildNarrativePrompt({
      kind: "morning",
      period: "today",
      sections,
      sourceErrors,
      lifeSummary,
      editorial,
      asOf,
      timeZone: "America/Los_Angeles",
    });
    const [instructions, encoded] = prompt.split("\nData:\n");
    const payload = JSON.parse(encoded);
    expect(encoded).toBe(JSON.stringify(payload));
    expect(payload).toMatchObject({
      kind: "morning",
      period: "today",
      sections,
      sourceErrors,
      lifeSummary,
      asOf,
      timeZone: "America/Los_Angeles",
      localAsOfDate: "2026-10-05",
    });
    expect(payload.sections.calendar[0].timeContext.startAt).toMatchObject({
      localDate: "2026-10-05",
      relationToAsOf: "after_as_of",
    });
    expect(payload.sections.life[0].timeContext.dueAt).toMatchObject({
      localDate: "2026-10-05",
      relationToAsOf: "before_as_of",
    });
    expect(payload.editorial.decisions).toEqual(
      editorial.decisions.map(({ itemId, action }) => ({ itemId, action })),
    );
    expect(instructions).toContain(
      "not_connected means no readable inbox connection",
    );
    expect(instructions).toContain("End after the verified facts");
    expect({ sections, sourceErrors, lifeSummary, editorial }).toEqual(before);
  });

  it.each([undefined, { inbox: "not_connected" as const }])(
    "applies ordinary status and exact local-time presentation with source errors %j",
    (sourceErrors) => {
      const sections: LifeOpsBriefingSections = {
        life: [
          {
            id: "open",
            kind: "reminder",
            title: "Open reminder",
            state: "visible",
            dueAt: "2026-10-06T01:01:00.000Z",
          },
          {
            id: "later",
            kind: "reminder",
            title: "Postponed reminder",
            state: "snoozed",
            dueAt: "2026-10-06T01:11:00.000Z",
          },
        ],
      };
      const before = structuredClone(sections);
      const prompt = buildNarrativePrompt({
        kind: "evening",
        period: "today",
        sections,
        sourceErrors,
        asOf,
        timeZone: "America/Los_Angeles",
      });
      const [instructions, json] = prompt.split("\nData:\n");
      expect(
        instructions.match(/do not use source\/status labels/g),
      ).toHaveLength(1);
      expect(instructions).toContain("visible means still open");
      expect(instructions).toContain("rather than guessing dayparts");
      const payload = JSON.parse(json);
      expect(
        payload.sections.life.map((item: { state: string }) => item.state),
      ).toEqual(["visible", "snoozed"]);
      expect(
        payload.sections.life.map(
          (item: { timeContext: { dueAt: { localTime: string } } }) =>
            item.timeContext.dueAt.localTime,
        ),
      ).toEqual(["Oct 5, 2026, 6:01 PM PDT", "Oct 5, 2026, 6:11 PM PDT"]);
      expect(payload.sourceErrors).toEqual(sourceErrors);
      expect(sections).toEqual(before);
    },
  );

  it("removes the exact captured demotion rationale while preserving all five source items and time facts", () => {
    // Capture 468 exposed this same five-reminder diagnostic shape. Titles and
    // identifiers here are synthetic; the internal reason is the exact value.
    const sections: LifeOpsBriefingSections = {
      calendar: [],
      life: Array.from({ length: 5 }, (_, index) => ({
        id: `reminder-${index}`,
        kind: "reminder" as const,
        title: `Reminder ${index}`,
        state: "visible" as const,
        dueAt: "2026-10-06T01:00:00.000Z",
      })),
      completedToday: [],
      commitments: [],
    };
    const editorial = buildBriefEditorialContract({
      sections,
      engagementSummaries,
    });
    const before = structuredClone({ sections, editorial });
    const prompt = buildNarrativePrompt({
      kind: "evening",
      period: "today",
      sections,
      editorial,
      sourceErrors: { inbox: "not_connected" },
      asOf,
      timeZone: "America/Los_Angeles",
    });
    const payload = JSON.parse(prompt.split("\nData:\n")[1]);
    expect(
      editorial.decisions.every(
        (decision) =>
          decision.reason ===
          "life:reminder has repeated ignore history with no acted-on signal",
      ),
    ).toBe(true);
    expect(prompt).not.toContain("repeated ignore history");
    expect(payload.editorial).not.toHaveProperty("demotedItemClasses");
    expect(payload.editorial.decisions).toEqual(
      editorial.decisions.map(({ itemId, action }) => ({ itemId, action })),
    );
    expect(
      payload.editorial.items.map((item: { itemId: string }) => item.itemId),
    ).toEqual(editorial.items.map((item) => item.itemId));
    for (const item of payload.editorial.items) {
      expect(item).not.toHaveProperty("itemClass");
      expect(item).not.toHaveProperty("consequenceScore");
      expect(item.summary).toContain("Oct 5, 2026, 6:00 PM PDT");
    }
    expect(payload.sections.life).toHaveLength(5);
    for (const [index, item] of payload.sections.life.entries()) {
      expect(item).toMatchObject(sections.life?.[index]);
      expect(item.timeContext.dueAt).toMatchObject({
        localDate: "2026-10-05",
        relationToAsOf: "before_as_of",
      });
    }
    expect(payload).toMatchObject({
      asOf,
      timeZone: "America/Los_Angeles",
      sourceErrors: { inbox: "not_connected" },
    });
    expect(prompt).toContain(
      "Completion and delivery cannot be inferred from a timestamp",
    );
    expect(prompt).toContain(
      "not_connected means no readable inbox connection",
    );
    expect({ sections, editorial }).toEqual(before);
  });

  it("keeps lead/include/demote/omit decisions, exact ordering, cap and actionable pushback", () => {
    const sections: LifeOpsBriefingSections = {
      calendar: Array.from({ length: 6 }, (_, index) => ({
        id: `meeting-${index}`,
        title: `Meeting ${index}`,
        startAt: "2026-10-06T03:00:00.000Z",
        endAt: "2026-10-06T04:00:00.000Z",
      })),
      life: ["first", "second"].map((id) => ({
        id,
        kind: "reminder" as const,
        title: id,
        dueAt: asOf,
      })),
    };
    const editorial = buildBriefEditorialContract({
      sections,
      engagementSummaries,
    });
    const prompt = buildNarrativePrompt({
      kind: "evening",
      period: "today",
      sections,
      editorial,
      asOf,
    });
    const payload = JSON.parse(prompt.split("\nData:\n")[1]);
    expect(
      new Set(
        payload.editorial.decisions.map(
          (decision: { action: string }) => decision.action,
        ),
      ),
    ).toEqual(new Set(["lead", "include", "demote", "omit"]));
    expect(payload.editorial.decisions).toEqual(
      editorial.decisions.map(({ itemId, action }) => ({ itemId, action })),
    );
    expect(
      payload.editorial.items.map((item: { itemId: string }) => item.itemId),
    ).toEqual(editorial.items.map((item) => item.itemId));
    expect(payload.editorial.maxItems).toBe(7);
    expect(payload.editorial.pushback).toBe(editorial.pushback);
    expect(payload.editorial.pushback).toContain("cancel, decline, or shorten");
    expect(payload.sections).toEqual(sections);
    expect(prompt).toContain('never resurface an "omit" item');
  });
});
