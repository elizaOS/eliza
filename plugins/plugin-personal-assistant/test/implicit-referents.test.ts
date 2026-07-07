/**
 * Tests for implicit referent resolution.
 *
 * Candidate stores are represented by seeded facts, threads, calendar records,
 * and episodic anchors so the ranking contract is deterministic before live
 * retrieval and executor wiring are added.
 */

import { describe, expect, it } from "vitest";
import { resolveImplicitReferent } from "../src/lifeops/implicit-referents/index.js";

const nowIso = "2026-07-06T16:00:00.000Z";

describe("implicit referent resolver", () => {
  it("resolves 'you know why' from recent context and confirms the interpretation", () => {
    const result = resolveImplicitReferent({
      ask: "Clear my afternoon. You know why.",
      nowIso,
      candidates: [
        {
          id: "calendar:board-prep",
          source: "recent_thread",
          label: "board prep afternoon block",
          summary:
            "Owner needs 1-5pm clear today for board prep; move the 1:1 and dentist.",
          confirmation:
            "clearing 1-5pm ahead of board prep, moving the 1:1 and dentist",
          tags: ["reason", "afternoon", "board", "prep"],
          occurredAt: "2026-07-06T13:00:00.000Z",
          prior: 0.78,
          executorHint: "calendar.bulk_reschedule.preview",
        },
        {
          id: "calendar:dentist",
          source: "calendar_event",
          label: "dentist appointment",
          summary: "Dentist appointment at 3pm.",
          confirmation: "protecting the dentist appointment",
          tags: ["afternoon"],
          occurredAt: "2026-07-01T16:00:00.000Z",
          prior: 0.2,
        },
      ],
    });

    expect(result.decision).toBe("resolved");
    if (result.decision !== "resolved") throw new Error("expected resolved");
    expect(result.selected.candidate.id).toBe("calendar:board-prep");
    expect(result.confirmationText).toContain(
      "clearing 1-5pm ahead of board prep",
    );
    expect(result.confirmationText).toContain('Resolving "Clear my afternoon');
  });

  it("resolves 'the usual' from owner facts without requiring restaurant-name lexical overlap", () => {
    const result = resolveImplicitReferent({
      ask: "Book the usual for Thursday.",
      nowIso,
      candidates: [
        {
          id: "fact:osteria",
          source: "owner_fact",
          label: "Osteria corner table preference",
          summary:
            "Owner's usual Thursday dinner is a corner table at Osteria at 7pm.",
          confirmation: "booking the usual Thursday Osteria corner table",
          tags: ["usual", "weekday", "restaurant", "thursday"],
          occurredAt: "2026-06-29T20:00:00.000Z",
          prior: 0.75,
          executorHint: "calendar.create_event.preview",
        },
        {
          id: "fact:coffee",
          source: "owner_fact",
          label: "Blue Bottle morning order",
          summary: "Owner usually gets an oat cappuccino in the morning.",
          confirmation: "ordering the usual morning coffee",
          tags: ["usual", "coffee"],
          occurredAt: "2026-06-20T16:00:00.000Z",
          prior: 0.3,
        },
      ],
    });

    expect(result.decision).toBe("resolved");
    if (result.decision !== "resolved") throw new Error("expected resolved");
    expect(result.selected.candidate.id).toBe("fact:osteria");
    expect(result.confirmationText).toContain(
      "booking the usual Thursday Osteria corner table",
    );
  });

  it("resolves same-as-last-time asks against episodic anchors", () => {
    const result = resolveImplicitReferent({
      ask: "Use the same reason as last time.",
      nowIso,
      candidates: [
        {
          id: "episode:travel-delay",
          source: "episodic_anchor",
          label: "last vendor delay explanation",
          summary:
            "Last time the owner moved a vendor call, the stated reason was board packet prep.",
          confirmation: "using the prior board packet prep reason",
          tags: ["episodic", "reason"],
          occurredAt: "2026-07-03T18:00:00.000Z",
          prior: 0.7,
        },
        {
          id: "fact:restaurant",
          source: "owner_fact",
          label: "usual restaurant",
          summary: "Usual restaurant preference.",
          confirmation: "using the usual restaurant preference",
          tags: ["usual"],
          prior: 0.2,
        },
      ],
    });

    expect(result.decision).toBe("resolved");
    if (result.decision !== "resolved") throw new Error("expected resolved");
    expect(result.selected.candidate.id).toBe("episode:travel-delay");
    expect(result.confirmationText).toContain(
      "using the prior board packet prep reason",
    );
  });

  it("asks one disambiguating question when two plausible referents are too close", () => {
    const result = resolveImplicitReferent({
      ask: "Clear it for Thursday.",
      nowIso,
      ambiguityMargin: 0.2,
      candidates: [
        {
          id: "calendar:board",
          source: "calendar_event",
          label: "Thursday board prep",
          summary: "Board prep block on Thursday afternoon.",
          confirmation: "clearing Thursday for board prep",
          tags: ["weekday", "thursday", "afternoon"],
          occurredAt: "2026-07-05T16:00:00.000Z",
          prior: 0.55,
        },
        {
          id: "calendar:investor",
          source: "calendar_event",
          label: "Thursday investor prep",
          summary: "Investor prep block on Thursday afternoon.",
          confirmation: "clearing Thursday for investor prep",
          tags: ["weekday", "thursday", "afternoon"],
          occurredAt: "2026-07-05T15:00:00.000Z",
          prior: 0.54,
        },
      ],
    });

    expect(result.decision).toBe("ask");
    if (result.decision !== "ask") throw new Error("expected ask");
    expect(result.question).toBe(
      "Do you mean Thursday board prep or Thursday investor prep?",
    );
    expect(result.selected).toBeNull();
  });
});
