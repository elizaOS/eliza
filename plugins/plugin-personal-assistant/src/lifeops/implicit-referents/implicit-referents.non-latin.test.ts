import { describe, expect, it } from "vitest";
import { resolveImplicitReferent } from "./index.js";

const NOW = "2026-10-11T00:00:00.000Z";

describe("resolveImplicitReferent non-Latin lexical matching", () => {
  it("matches a Korean ask against a Korean candidate like the English control", () => {
    const result = resolveImplicitReferent({
      ask: "회의실 예약 일정 확인해줘",
      nowIso: NOW,
      candidates: [
        {
          id: "ko-trip",
          source: "recent_thread",
          label: "회의실 예약 일정",
          summary: "회의실 예약 일정 확인 건",
          confirmation: "the meeting-room booking schedule",
        },
        {
          id: "en-other",
          source: "recent_thread",
          label: "Quarterly budget review",
          summary: "Quarterly budget review thread",
          confirmation: "the quarterly budget review",
        },
      ],
    });
    const trip = result.ranked.find((r) => r.candidate.id === "ko-trip");
    expect(trip).toBeDefined();
    expect(trip?.score).toBeGreaterThan(0);
    expect(trip?.evidence.some((e) => e.startsWith("matched"))).toBe(true);
    expect(result.ranked[0]?.candidate.id).toBe("ko-trip");
  });

  it("matches a spaceless Japanese ask against a Japanese candidate", () => {
    const result = resolveImplicitReferent({
      ask: "会議室予約日程確認して",
      nowIso: NOW,
      candidates: [
        {
          id: "ja-room",
          source: "recent_thread",
          label: "会議室予約日程",
          summary: "会議室予約日程",
          confirmation: "the meeting-room booking schedule",
        },
        {
          id: "en-other",
          source: "recent_thread",
          label: "Quarterly budget review",
          summary: "Quarterly budget review thread",
          confirmation: "the quarterly budget review",
        },
      ],
    });
    const room = result.ranked.find((r) => r.candidate.id === "ja-room");
    expect(room).toBeDefined();
    expect(room?.score).toBeGreaterThan(0);
    expect(room?.evidence.some((e) => e.startsWith("matched"))).toBe(true);
    expect(result.ranked[0]?.candidate.id).toBe("ja-room");
  });

  it("keeps a two-character Chinese keyword instead of dropping it", () => {
    const result = resolveImplicitReferent({
      ask: "酒店",
      nowIso: NOW,
      candidates: [
        {
          id: "zh-hotel",
          source: "recent_thread",
          label: "酒店预订",
          summary: "酒店预订确认",
          confirmation: "the hotel booking",
        },
        {
          id: "en-other",
          source: "recent_thread",
          label: "Quarterly budget review",
          summary: "Quarterly budget review thread",
          confirmation: "the quarterly budget review",
        },
      ],
    });
    const hotel = result.ranked.find((r) => r.candidate.id === "zh-hotel");
    expect(hotel).toBeDefined();
    expect(hotel?.score).toBeGreaterThan(0);
    expect(hotel?.evidence).toContain('matched "酒店"');
    expect(result.ranked[0]?.candidate.id).toBe("zh-hotel");
  });

  it("matches an accented Latin ask against an unaccented stored label", () => {
    const candidates = [
      {
        id: "cafe-sync",
        source: "calendar_event" as const,
        label: "Cafe du matin sync",
        summary: "Cafe du matin sync",
        confirmation: "the cafe sync",
      },
      {
        id: "matin-standup",
        source: "calendar_event" as const,
        label: "Matin standup",
        summary: "Matin standup",
        confirmation: "the morning standup",
        prior: 0.5,
      },
    ];
    const accentedAsk = resolveImplicitReferent({
      ask: "Le Café du matin",
      nowIso: NOW,
      candidates,
    });
    const cafe = accentedAsk.ranked.find((r) => r.candidate.id === "cafe-sync");
    expect(cafe?.evidence).toContain('matched "cafe"');
    expect(cafe?.evidence).toContain('matched "matin"');
    expect(accentedAsk.ranked[0]?.candidate.id).toBe("cafe-sync");

    const unaccentedAsk = resolveImplicitReferent({
      ask: "Le Cafe du matin",
      nowIso: NOW,
      candidates: candidates.map((c) =>
        c.id === "cafe-sync"
          ? { ...c, label: "Café du matin sync", summary: "Café du matin sync" }
          : c,
      ),
    });
    expect(unaccentedAsk.ranked[0]?.candidate.id).toBe("cafe-sync");
  });

  it("keeps English matching and cross-language isolation unchanged", () => {
    const result = resolveImplicitReferent({
      ask: "what happened with the seoul trip hotel booking",
      nowIso: NOW,
      candidates: [
        {
          id: "en-trip",
          source: "recent_thread",
          label: "Seoul trip hotel booking",
          summary: "Seoul trip hotel booking status",
          confirmation: "the Seoul trip hotel booking",
        },
        {
          id: "ko-other",
          source: "recent_thread",
          label: "회의실 예약 일정",
          summary: "회의실 예약 일정 확인 건",
          confirmation: "the meeting-room booking schedule",
        },
      ],
    });
    const trip = result.ranked.find((r) => r.candidate.id === "en-trip");
    const other = result.ranked.find((r) => r.candidate.id === "ko-other");
    expect(trip?.evidence.filter((e) => e.startsWith("matched"))).toHaveLength(
      4,
    );
    expect(other?.score).toBe(0);
  });
  it("keeps Japanese voiced and unvoiced kana distinct", () => {
    const result = resolveImplicitReferent({
      ask: "ガス",
      nowIso: NOW,
      candidates: [
        {
          id: "unvoiced",
          source: "recent_thread",
          label: "カス",
          summary: "カス",
          confirmation: "unvoiced candidate",
        },
        {
          id: "voiced",
          source: "recent_thread",
          label: "ガス",
          summary: "ガス",
          confirmation: "voiced candidate",
        },
      ],
    });
    expect(result.ranked[0]?.candidate.id).toBe("voiced");
    expect(
      result.ranked.find((entry) => entry.candidate.id === "unvoiced")?.score,
    ).toBe(0);
  });
});
