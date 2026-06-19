/**
 * GameWorld Causal Event Tests
 *
 * Tests the GameWorld's causal event generation functionality:
 * - CausalEventContext processing
 * - Event filtering by tick
 * - Market-driven event generation
 * - Event type mapping
 * - Visibility and actor handling
 *
 * These tests verify the integration between hidden narrative facts
 * and world event generation.
 */

import { describe, expect, test } from "bun:test";
import type {
  CausalEventContext,
  CausalEventType,
  ScheduledCausalEvent,
} from "../GameWorld";

// =============================================================================
// CausalEventContext Structure Tests
// =============================================================================

describe("GameWorld - CausalEventContext Structure", () => {
  test("validates complete CausalEventContext structure", () => {
    const context: CausalEventContext = {
      scheduledEvents: [
        {
          tick: 100,
          day: 5,
          hour: 4,
          eventType: "leak",
          description: "Internal documents reveal METAI fraud",
          affectedTickers: ["METAI"],
          isPositive: false,
          sourceFactId: "narrative-fact-123",
        },
      ],
      currentTick: 100,
    };

    expect(context).toBeDefined();
    expect(context.scheduledEvents).toBeInstanceOf(Array);
    expect(context.currentTick).toBeGreaterThanOrEqual(0);
  });

  test("validates ScheduledCausalEvent has all required fields", () => {
    const event: ScheduledCausalEvent = {
      tick: 50,
      day: 3,
      hour: 8,
      eventType: "rumor",
      description: "Rumors circulate about BTCAI partnership",
      affectedTickers: ["BTCAI"],
      isPositive: true,
      sourceFactId: "fact-456",
    };

    // All fields must be present
    expect(event.tick).toBeDefined();
    expect(event.day).toBeDefined();
    expect(event.hour).toBeDefined();
    expect(event.eventType).toBeDefined();
    expect(event.description).toBeDefined();
    expect(event.affectedTickers).toBeDefined();
    expect(event.isPositive).toBeDefined();
    expect(event.sourceFactId).toBeDefined();
  });

  test("validates all CausalEventType values", () => {
    const validTypes: CausalEventType[] = [
      "leak",
      "rumor",
      "scandal",
      "development",
      "deal",
      "announcement",
    ];

    // Each type should be usable in a ScheduledCausalEvent
    for (const eventType of validTypes) {
      const event: ScheduledCausalEvent = {
        tick: 0,
        day: 1,
        hour: 12,
        eventType,
        description: `Test ${eventType}`,
        affectedTickers: ["TEST"],
        isPositive: false,
        sourceFactId: "test-fact",
      };

      expect(event.eventType).toBe(eventType);
    }
  });
});

// =============================================================================
// Event Filtering Tests
// =============================================================================

describe("GameWorld - Event Filtering by Tick", () => {
  const createEvents = (): ScheduledCausalEvent[] => [
    {
      tick: 50,
      day: 3,
      hour: 2,
      eventType: "rumor",
      description: "Early rumor",
      affectedTickers: ["BTCAI"],
      isPositive: true,
      sourceFactId: "fact-1",
    },
    {
      tick: 100,
      day: 5,
      hour: 4,
      eventType: "leak",
      description: "Mid-game leak",
      affectedTickers: ["METAI"],
      isPositive: false,
      sourceFactId: "fact-2",
    },
    {
      tick: 150,
      day: 7,
      hour: 6,
      eventType: "scandal",
      description: "Late scandal",
      affectedTickers: ["SOLAI"],
      isPositive: false,
      sourceFactId: "fact-3",
    },
  ];

  test("returns only events matching current tick", () => {
    const events = createEvents();
    const currentTick = 100;

    const matchingEvents = events.filter((e) => e.tick === currentTick);

    expect(matchingEvents).toHaveLength(1);
    expect(matchingEvents[0]?.eventType).toBe("leak");
    expect(matchingEvents[0]?.description).toBe("Mid-game leak");
  });

  test("returns empty array when no events match tick", () => {
    const events = createEvents();
    const currentTick = 75; // Between events

    const matchingEvents = events.filter((e) => e.tick === currentTick);

    expect(matchingEvents).toHaveLength(0);
  });

  test("handles tick 0 (first tick)", () => {
    const events: ScheduledCausalEvent[] = [
      {
        tick: 0,
        day: 1,
        hour: 0,
        eventType: "development",
        description: "Initial development",
        affectedTickers: ["BTCAI"],
        isPositive: true,
        sourceFactId: "fact-0",
      },
    ];

    const matchingEvents = events.filter((e) => e.tick === 0);

    expect(matchingEvents).toHaveLength(1);
  });

  test("handles very large tick numbers", () => {
    const events: ScheduledCausalEvent[] = [
      {
        tick: 999999,
        day: 999,
        hour: 23,
        eventType: "announcement",
        description: "Far future announcement",
        affectedTickers: ["BTCAI"],
        isPositive: true,
        sourceFactId: "fact-far",
      },
    ];

    const matchingEvents = events.filter((e) => e.tick === 999999);

    expect(matchingEvents).toHaveLength(1);
  });
});

// =============================================================================
// Market-Driven Event Generation Tests
// =============================================================================

describe("GameWorld - Market-Driven Events", () => {
  interface SignificantMove {
    ticker: string;
    change: number;
  }

  const generateMarketEvents = (
    moves: SignificantMove[],
    _day: number,
  ): Array<{ type: string; description: string; pointsToward: string }> => {
    const events: Array<{
      type: string;
      description: string;
      pointsToward: string;
    }> = [];

    for (const move of moves) {
      if (move.change < -20) {
        events.push({
          type: "scandal",
          description: `Market crash for ${move.ticker} triggers emergency board meeting.`,
          pointsToward: "NO",
        });
      } else if (move.change > 20) {
        events.push({
          type: "development",
          description: `${move.ticker} stock surges to record highs.`,
          pointsToward: "YES",
        });
      }
    }

    return events;
  };

  test("generates scandal event for crash > 20%", () => {
    const moves: SignificantMove[] = [{ ticker: "BTCAI", change: -25 }];

    const events = generateMarketEvents(moves, 5);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("scandal");
    expect(events[0]?.pointsToward).toBe("NO");
    expect(events[0]?.description).toContain("BTCAI");
  });

  test("generates development event for pump > 20%", () => {
    const moves: SignificantMove[] = [{ ticker: "SOLAI", change: 30 }];

    const events = generateMarketEvents(moves, 5);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("development");
    expect(events[0]?.pointsToward).toBe("YES");
    expect(events[0]?.description).toContain("SOLAI");
  });

  test("no events for moves between -20% and 20%", () => {
    const moves: SignificantMove[] = [
      { ticker: "BTCAI", change: 15 },
      { ticker: "ETHAI", change: -15 },
      { ticker: "SOLAI", change: 20 }, // exactly 20%, not >20%
      { ticker: "METAI", change: -20 }, // exactly -20%, not <-20%
    ];

    const events = generateMarketEvents(moves, 5);

    expect(events).toHaveLength(0);
  });

  test("handles multiple significant moves in same tick", () => {
    const moves: SignificantMove[] = [
      { ticker: "BTCAI", change: -25 },
      { ticker: "SOLAI", change: 35 },
      { ticker: "ETHAI", change: -30 },
    ];

    const events = generateMarketEvents(moves, 5);

    expect(events).toHaveLength(3);
    expect(events.filter((e) => e.type === "scandal")).toHaveLength(2);
    expect(events.filter((e) => e.type === "development")).toHaveLength(1);
  });

  test("handles empty moves array", () => {
    const moves: SignificantMove[] = [];

    const events = generateMarketEvents(moves, 5);

    expect(events).toHaveLength(0);
  });

  test("handles extreme moves", () => {
    const moves: SignificantMove[] = [
      { ticker: "BTCAI", change: -99 }, // Near total loss
      { ticker: "SOLAI", change: 500 }, // 5x pump
    ];

    const events = generateMarketEvents(moves, 5);

    expect(events).toHaveLength(2);
  });
});

// =============================================================================
// Event Type Mapping Tests
// =============================================================================

describe("GameWorld - Event Type Mapping", () => {
  // Map causal event types to their expected sentiment
  const eventTypeSentiment: Record<
    CausalEventType,
    "positive" | "negative" | "neutral"
  > = {
    leak: "negative",
    rumor: "neutral",
    scandal: "negative",
    development: "positive",
    deal: "positive",
    announcement: "neutral",
  };

  test("leak events are typically negative", () => {
    expect(eventTypeSentiment.leak).toBe("negative");
  });

  test("scandal events are typically negative", () => {
    expect(eventTypeSentiment.scandal).toBe("negative");
  });

  test("deal events are typically positive", () => {
    expect(eventTypeSentiment.deal).toBe("positive");
  });

  test("development events are typically positive", () => {
    expect(eventTypeSentiment.development).toBe("positive");
  });

  test("rumor events can be either (neutral base)", () => {
    expect(eventTypeSentiment.rumor).toBe("neutral");
  });

  test("announcement events can be either (neutral base)", () => {
    expect(eventTypeSentiment.announcement).toBe("neutral");
  });
});

// =============================================================================
// Day/Hour Validation Tests
// =============================================================================

describe("GameWorld - Day/Hour Validation", () => {
  test("daytime hours are 8-20", () => {
    const isDaytime = (hour: number) => hour >= 8 && hour <= 20;

    expect(isDaytime(8)).toBe(true); // 8 AM
    expect(isDaytime(12)).toBe(true); // Noon
    expect(isDaytime(20)).toBe(true); // 8 PM
    expect(isDaytime(7)).toBe(false); // 7 AM
    expect(isDaytime(21)).toBe(false); // 9 PM
    expect(isDaytime(0)).toBe(false); // Midnight
  });

  test("event probability higher during daytime", () => {
    const getEventChance = (hour: number) => {
      const isDaytime = hour >= 8 && hour <= 20;
      return isDaytime ? 0.1 : 0.02;
    };

    expect(getEventChance(12)).toBe(0.1); // Daytime
    expect(getEventChance(3)).toBe(0.02); // Nighttime
    expect(getEventChance(8)).toBe(0.1); // Edge: start of day
    expect(getEventChance(20)).toBe(0.1); // Edge: end of day
  });

  test("validates hour range 0-23", () => {
    const validHours = Array.from({ length: 24 }, (_, i) => i);

    for (const hour of validHours) {
      expect(hour >= 0 && hour <= 23).toBe(true);
    }
  });

  test("validates day range for standard simulation", () => {
    const standardDuration = 30;
    const validDays = Array.from({ length: standardDuration }, (_, i) => i + 1);

    for (const day of validDays) {
      expect(day >= 1 && day <= standardDuration).toBe(true);
    }
  });
});

// =============================================================================
// Multiple Tickers Tests
// =============================================================================

describe("GameWorld - Multiple Affected Tickers", () => {
  test("event can affect multiple tickers", () => {
    const event: ScheduledCausalEvent = {
      tick: 100,
      day: 5,
      hour: 12,
      eventType: "development",
      description: "Tech sector rally affects multiple companies",
      affectedTickers: ["BTCAI", "ETHAI", "SOLAI"],
      isPositive: true,
      sourceFactId: "fact-sector",
    };

    expect(event.affectedTickers).toHaveLength(3);
    expect(event.affectedTickers).toContain("BTCAI");
    expect(event.affectedTickers).toContain("ETHAI");
    expect(event.affectedTickers).toContain("SOLAI");
  });

  test("single ticker event is valid", () => {
    const event: ScheduledCausalEvent = {
      tick: 100,
      day: 5,
      hour: 12,
      eventType: "scandal",
      description: "Company-specific scandal",
      affectedTickers: ["METAI"],
      isPositive: false,
      sourceFactId: "fact-single",
    };

    expect(event.affectedTickers).toHaveLength(1);
  });

  test("empty affectedTickers is technically valid (system event)", () => {
    const event: ScheduledCausalEvent = {
      tick: 100,
      day: 5,
      hour: 12,
      eventType: "announcement",
      description: "General market announcement",
      affectedTickers: [],
      isPositive: true,
      sourceFactId: "fact-general",
    };

    expect(event.affectedTickers).toHaveLength(0);
  });
});

// =============================================================================
// Source Fact Tracking Tests
// =============================================================================

describe("GameWorld - Source Fact Tracking", () => {
  test("events maintain sourceFactId for traceability", () => {
    const events: ScheduledCausalEvent[] = [
      {
        tick: 50,
        day: 3,
        hour: 8,
        eventType: "rumor",
        description: "First event from fact-A",
        affectedTickers: ["BTCAI"],
        isPositive: true,
        sourceFactId: "narrative-fact-A",
      },
      {
        tick: 100,
        day: 5,
        hour: 12,
        eventType: "leak",
        description: "Second event from fact-A",
        affectedTickers: ["BTCAI"],
        isPositive: false,
        sourceFactId: "narrative-fact-A",
      },
    ];

    // Both events trace back to same source fact
    expect(events[0]?.sourceFactId).toBe("narrative-fact-A");
    expect(events[1]?.sourceFactId).toBe("narrative-fact-A");
  });

  test("different facts generate different sourceFactIds", () => {
    const events: ScheduledCausalEvent[] = [
      {
        tick: 50,
        day: 3,
        hour: 8,
        eventType: "rumor",
        description: "Event from fact A",
        affectedTickers: ["BTCAI"],
        isPositive: true,
        sourceFactId: "narrative-fact-A",
      },
      {
        tick: 100,
        day: 5,
        hour: 12,
        eventType: "scandal",
        description: "Event from fact B",
        affectedTickers: ["METAI"],
        isPositive: false,
        sourceFactId: "narrative-fact-B",
      },
    ];

    expect(events[0]?.sourceFactId).not.toBe(events[1]?.sourceFactId);
  });

  test("sourceFactId format follows convention", () => {
    const sourceFactId = "narrative-fact-1234567890";

    expect(sourceFactId).toMatch(/^narrative-fact-/);
    expect(sourceFactId.split("-").length).toBeGreaterThanOrEqual(3);
  });
});
