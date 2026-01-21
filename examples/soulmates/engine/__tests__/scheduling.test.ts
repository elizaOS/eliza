import { beforeEach, describe, expect, it } from "vitest";
import { generatePersonas } from "../generator";
import { proposeMeetingRecord } from "../scheduling";
import type {
  LocationSuggestionProvider,
  MatchRecord,
  Persona,
} from "../types";

describe("proposeMeetingRecord", () => {
  const now = "2026-01-18T12:00:00.000Z";
  let personas: Persona[];

  beforeEach(() => {
    personas = generatePersonas({ seed: 42, count: 10, now });
  });

  it("should propose meeting when personas have overlapping availability", async () => {
    const personaA = personas[0];
    const personaB = personas[1];
    personaA.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "mon", startMinutes: 600, endMinutes: 780 }],
      exceptions: [],
    };
    personaB.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "mon", startMinutes: 540, endMinutes: 720 }],
      exceptions: [],
    };

    const match: MatchRecord = {
      matchId: "test-match",
      domain: "dating",
      personaA: personaA.id,
      personaB: personaB.id,
      createdAt: now,
      status: "proposed",
      assessment: {
        score: 70,
        positiveReasons: [],
        negativeReasons: [],
        redFlags: [],
      },
      reasoning: [],
    };

    const meeting = await proposeMeetingRecord(
      match,
      personaA,
      personaB,
      now,
      undefined,
      120,
      () => "meet-id",
    );
    expect(meeting).toBeDefined();
    if (meeting) {
      expect(meeting.meetingId).toBe("meet-id");
      expect(meeting.matchId).toBe("test-match");
      expect(meeting.status).toBe("scheduled");
      expect(meeting.rescheduleCount).toBe(0);
    }
  });

  it("should return null when no availability overlap exists", async () => {
    const personaA = personas[0];
    const personaB = personas[1];
    personaA.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "mon", startMinutes: 600, endMinutes: 720 }],
      exceptions: [],
    };
    personaB.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "tue", startMinutes: 600, endMinutes: 720 }],
      exceptions: [],
    };

    const match: MatchRecord = {
      matchId: "test-match",
      domain: "dating",
      personaA: personaA.id,
      personaB: personaB.id,
      createdAt: now,
      status: "proposed",
      assessment: {
        score: 70,
        positiveReasons: [],
        negativeReasons: [],
        redFlags: [],
      },
      reasoning: [],
    };

    const meeting = await proposeMeetingRecord(
      match,
      personaA,
      personaB,
      now,
      undefined,
      120,
      () => "meet-id",
    );
    expect(meeting).toBeNull();
  });

  it("should return null when overlap is less than minimum minutes", async () => {
    const personaA = personas[0];
    const personaB = personas[1];
    personaA.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "mon", startMinutes: 600, endMinutes: 660 }],
      exceptions: [],
    };
    personaB.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "mon", startMinutes: 630, endMinutes: 720 }],
      exceptions: [],
    };

    const match: MatchRecord = {
      matchId: "test-match",
      domain: "dating",
      personaA: personaA.id,
      personaB: personaB.id,
      createdAt: now,
      status: "proposed",
      assessment: {
        score: 70,
        positiveReasons: [],
        negativeReasons: [],
        redFlags: [],
      },
      reasoning: [],
    };

    const meeting = await proposeMeetingRecord(
      match,
      personaA,
      personaB,
      now,
      undefined,
      120,
      () => "meet-id",
    );
    expect(meeting).toBeNull();
  });

  it("should use location provider when available", async () => {
    const personaA = personas[0];
    const personaB = personas[1];
    personaA.general.location.city = "San Francisco";
    personaB.general.location.city = "San Francisco";
    personaA.profile.interests = ["coffee", "music"];
    personaB.profile.interests = ["coffee", "art"];
    personaA.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "mon", startMinutes: 600, endMinutes: 780 }],
      exceptions: [],
    };
    personaB.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "mon", startMinutes: 600, endMinutes: 780 }],
      exceptions: [],
    };

    const mockProvider: LocationSuggestionProvider = {
      suggest: async (request) => {
        expect(request.city).toBe("San Francisco");
        expect(request.interests.some((i) => i === "coffee")).toBe(true);
        return [
          {
            name: "Blue Bottle Coffee",
            address: "66 Mint St",
            city: "San Francisco",
            placeId: "place-123",
            notes: "Great coffee spot",
          },
        ];
      },
    };

    const match: MatchRecord = {
      matchId: "test-match",
      domain: "dating",
      personaA: personaA.id,
      personaB: personaB.id,
      createdAt: now,
      status: "proposed",
      assessment: {
        score: 70,
        positiveReasons: [],
        negativeReasons: [],
        redFlags: [],
      },
      reasoning: [],
    };

    const meeting = await proposeMeetingRecord(
      match,
      personaA,
      personaB,
      now,
      mockProvider,
      120,
      () => "meet-id",
    );
    expect(meeting).toBeDefined();
    expect(meeting?.location.name).toBe("Blue Bottle Coffee");
    expect(meeting?.location.placeId).toBe("place-123");
  });

  it("should use placeholder location when provider is not available", async () => {
    const personaA = personas[0];
    const personaB = personas[1];
    personaA.general.location.city = "San Francisco";
    personaB.general.location.city = "San Francisco";
    personaA.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "mon", startMinutes: 600, endMinutes: 780 }],
      exceptions: [],
    };
    personaB.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "mon", startMinutes: 600, endMinutes: 780 }],
      exceptions: [],
    };

    const match: MatchRecord = {
      matchId: "test-match",
      domain: "dating",
      personaA: personaA.id,
      personaB: personaB.id,
      createdAt: now,
      status: "proposed",
      assessment: {
        score: 70,
        positiveReasons: [],
        negativeReasons: [],
        redFlags: [],
      },
      reasoning: [],
    };

    const meeting = await proposeMeetingRecord(
      match,
      personaA,
      personaB,
      now,
      undefined,
      120,
      () => "meet-id",
    );
    expect(meeting).toBeDefined();
    expect(meeting?.location.name).toBe("TBD");
    expect(meeting?.location.city).toBe("San Francisco");
  });

  it("should return null when time zones differ", async () => {
    const personaA = personas[0];
    const personaB = personas[1];
    personaA.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "mon", startMinutes: 600, endMinutes: 780 }],
      exceptions: [],
    };
    personaB.profile.availability = {
      timeZone: "America/New_York",
      weekly: [{ day: "mon", startMinutes: 600, endMinutes: 780 }],
      exceptions: [],
    };

    const match: MatchRecord = {
      matchId: "test-match",
      domain: "dating",
      personaA: personaA.id,
      personaB: personaB.id,
      createdAt: now,
      status: "proposed",
      assessment: {
        score: 70,
        positiveReasons: [],
        negativeReasons: [],
        redFlags: [],
      },
      reasoning: [],
    };

    const meeting = await proposeMeetingRecord(
      match,
      personaA,
      personaB,
      now,
      undefined,
      120,
      () => "meet-id",
    );
    expect(meeting).toBeNull();
  });

  it("should find slot in next 7 days", async () => {
    const personaA = personas[0];
    const personaB = personas[1];
    personaA.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "fri", startMinutes: 600, endMinutes: 780 }],
      exceptions: [],
    };
    personaB.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [{ day: "fri", startMinutes: 600, endMinutes: 780 }],
      exceptions: [],
    };

    const match: MatchRecord = {
      matchId: "test-match",
      domain: "dating",
      personaA: personaA.id,
      personaB: personaB.id,
      createdAt: "2026-01-19T09:00:00.000Z",
      status: "proposed",
      assessment: {
        score: 70,
        positiveReasons: [],
        negativeReasons: [],
        redFlags: [],
      },
      reasoning: [],
    };

    const meeting = await proposeMeetingRecord(
      match,
      personaA,
      personaB,
      "2026-01-19T09:00:00.000Z",
      undefined,
      120,
      () => "meet-id",
    );
    expect(meeting).toBeDefined();
  });

  it("should skip slots in the past or too soon", async () => {
    const personaA = personas[0];
    const personaB = personas[1];
    const nowDate = new Date("2026-01-20T14:00:00.000Z");
    personaA.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [
        { day: "mon", startMinutes: 480, endMinutes: 600 },
        { day: "mon", startMinutes: 900, endMinutes: 1020 },
      ],
      exceptions: [],
    };
    personaB.profile.availability = {
      timeZone: "America/Los_Angeles",
      weekly: [
        { day: "mon", startMinutes: 480, endMinutes: 600 },
        { day: "mon", startMinutes: 900, endMinutes: 1020 },
      ],
      exceptions: [],
    };

    const match: MatchRecord = {
      matchId: "test-match",
      domain: "dating",
      personaA: personaA.id,
      personaB: personaB.id,
      createdAt: nowDate.toISOString(),
      status: "proposed",
      assessment: {
        score: 70,
        positiveReasons: [],
        negativeReasons: [],
        redFlags: [],
      },
      reasoning: [],
    };

    const meeting = await proposeMeetingRecord(
      match,
      personaA,
      personaB,
      nowDate.toISOString(),
      undefined,
      120,
      () => "meet-id",
    );
    expect(meeting).toBeDefined();
  });
});
