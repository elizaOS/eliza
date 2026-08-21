/**
 * Surrogate-pair regression for calendar description truncation at the 240-
 * and 120-code-unit caps.
 *
 * `formatCalendarCandidateForGrounding` caps at 240 for LLM grounding and
 * `formatCalendarSearchResults` caps at 120 for user-facing previews. Both
 * caps previously used `String#slice`, which can split a surrogate pair
 * (e.g. fox = U+1F98A) leaving a lone surrogate that breaks JSON and
 * rendering. The production seams now sanitize via `toWellFormedUnicode` and
 * clamp via `truncateWellFormed` so the boundary backs off. These tests drive
 * the exported production formatters directly so reverting either site to
 * `.slice` makes the suite red.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  formatCalendarCandidateForGrounding,
  formatCalendarDescriptionForGrounding,
  formatCalendarDescriptionForSearchPreview,
  formatCalendarSearchResults,
} from "./calendar-handler.js";

const FOX = "🦊"; // 🦊 — surrogate pair 🦊, 2 code units

function isWellFormed(value: string): boolean {
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function eventWithDescription(description: string): LifeOpsCalendarEvent {
  return {
    id: "evt-1",
    calendarId: "primary",
    title: "Test Event",
    startAt: "2026-08-03T15:00:00.000Z",
    endAt: "2026-08-03T16:00:00.000Z",
    timezone: "UTC",
    isAllDay: false,
    location: "",
    description,
    attendees: [],
  } as unknown as LifeOpsCalendarEvent;
}

function candidateWithDescription(description: string) {
  return {
    event: eventWithDescription(description),
    score: 10,
    matchedQueries: [] as string[],
  };
}

describe("calendar-handler description 240/120 surrogate safety", () => {
  it("240 grounding narrow seam backs off mid-pair", () => {
    const input = `${"a".repeat(239)}${FOX}b`;
    const out = formatCalendarDescriptionForGrounding(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(239);
    expect(() => JSON.stringify(out)).not.toThrow();
    // Narrow seam is the 240 site; reverting it to slice(0,240) would keep the lone high surrogate
  });

  it("240 grounding candidate formatter backs off mid-pair via exported seam", () => {
    const input = `${"a".repeat(239)}${FOX}b`;
    const rendered = formatCalendarCandidateForGrounding(
      candidateWithDescription(input),
    );
    const descLine =
      rendered.split("\n").find((l) => l.startsWith("description: ")) ?? "";
    const descValue = descLine.slice("description: ".length);
    expect(isWellFormed(rendered)).toBe(true);
    expect(isWellFormed(descValue)).toBe(true);
    expect(descValue.length).toBe(239);
    expect(descValue.length).toBeLessThanOrEqual(240);
    expect(() => JSON.stringify(rendered)).not.toThrow();
  });

  it("120 search narrow seam backs off mid-pair", () => {
    const input = `${"a".repeat(119)}${FOX}b`;
    const out = formatCalendarDescriptionForSearchPreview(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(119);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("120 search formatter backs off mid-pair via exported seam", () => {
    const input = `${"a".repeat(119)}${FOX}b`;
    const output = formatCalendarSearchResults(
      [eventWithDescription(input), eventWithDescription("other")],
      "dentist",
      "this week",
    );
    expect(isWellFormed(output)).toBe(true);
    expect(() => JSON.stringify(output)).not.toThrow();
    // The second event's description line is the truncated one; extract it
    const descLines = output
      .split("\n")
      .filter((l) => l.startsWith("  ") && l.includes("a"));
    const truncatedLine = descLines[0] ?? "";
    const truncatedValue = truncatedLine.trim();
    expect(isWellFormed(truncatedValue)).toBe(true);
    expect(truncatedValue.length).toBeLessThanOrEqual(120);
    expect(truncatedValue.length).toBe(119);
  });

  it("preserves fitting emoji at both caps", () => {
    expect(
      formatCalendarDescriptionForGrounding(`${"a".repeat(238)}${FOX}`),
    ).toBe(`${"a".repeat(238)}${FOX}`);
    expect(
      formatCalendarDescriptionForSearchPreview(`${"a".repeat(118)}${FOX}`),
    ).toBe(`${"a".repeat(118)}${FOX}`);
    const g = formatCalendarCandidateForGrounding(
      candidateWithDescription(`${"a".repeat(238)}${FOX}`),
    );
    expect(isWellFormed(g)).toBe(true);
    expect(g).toContain(FOX);
    const s = formatCalendarSearchResults(
      [
        eventWithDescription(`${"a".repeat(118)}${FOX}`),
        eventWithDescription("x"),
      ],
      "q",
      "label",
    );
    expect(isWellFormed(s)).toBe(true);
    expect(s).toContain(FOX);
  });

  it("sweep at 240 and 120 keeps outputs well-formed", () => {
    for (let off = 0; off <= 65; off++) {
      const g = formatCalendarDescriptionForGrounding(
        `${"a".repeat(off)}${FOX}${"b".repeat(300)}`,
      );
      expect(isWellFormed(g)).toBe(true);
      expect(g.length).toBeLessThanOrEqual(240);
      expect(() => JSON.stringify(g)).not.toThrow();
      const s = formatCalendarDescriptionForSearchPreview(
        `${"a".repeat(off)}${FOX}${"b".repeat(200)}`,
      );
      expect(isWellFormed(s)).toBe(true);
      expect(s.length).toBeLessThanOrEqual(120);
    }
    // Also sweep through exported formatters
    for (let off = 0; off <= 12; off++) {
      const rendered = formatCalendarSearchResults(
        [
          eventWithDescription(`${"a".repeat(off)}${FOX}${"b".repeat(300)}`),
          eventWithDescription("y"),
        ],
        "q",
        "label",
      );
      expect(isWellFormed(rendered)).toBe(true);
    }
  });

  it("lone surrogate is sanitised via production seams", () => {
    const lone240 = formatCalendarDescriptionForGrounding(
      `ok \ud83d ${"x".repeat(300)}`,
    );
    expect(isWellFormed(lone240)).toBe(true);
    expect(lone240.includes("�")).toBe(true);
    const lone120 = formatCalendarDescriptionForSearchPreview(
      `ok \ud83d ${"x".repeat(300)}`,
    );
    expect(isWellFormed(lone120)).toBe(true);
    expect(lone120.includes("�")).toBe(true);
    const loneViaCandidate = formatCalendarCandidateForGrounding(
      candidateWithDescription(`ok \ud83d ${"x".repeat(300)}`),
    );
    expect(isWellFormed(loneViaCandidate)).toBe(true);
    expect(loneViaCandidate.includes("�")).toBe(true);
    const loneViaSearch = formatCalendarSearchResults(
      [
        eventWithDescription(`ok \ud83d ${"x".repeat(300)}`),
        eventWithDescription("y"),
      ],
      "q",
      "label",
    );
    expect(isWellFormed(loneViaSearch)).toBe(true);
    expect(loneViaSearch.includes("�")).toBe(true);
  });

  it("grounding prompt stays well-formed and bounded", () => {
    const input = `${"a".repeat(239)}${FOX}b`;
    const rendered = formatCalendarCandidateForGrounding(
      candidateWithDescription(input),
    );
    expect(isWellFormed(rendered)).toBe(true);
    expect(() => JSON.stringify(rendered)).not.toThrow();
    const descValue = (
      rendered.split("\n").find((l) => l.startsWith("description: ")) ?? ""
    ).slice("description: ".length);
    expect(descValue.length).toBeLessThanOrEqual(240);
  });
});
