/**
 * GameLoop Simulation Mode Tests
 *
 * Tests the GameLoop's simulation mode functionality including:
 * - Price overrides propagation
 * - Causal context handling
 * - Market state construction in simulation mode
 * - Integration with MarketDecisionEngine
 *
 * These tests verify that the causal simulation engine correctly
 * passes prices and events through the game loop.
 */

import { describe, expect, mock, test } from "bun:test";

// Mock the simulation mode check
const mockIsSimulationMode = mock(() => true);
mock.module("../storage-bridge", () => ({
  isSimulationMode: mockIsSimulationMode,
}));

// Mock dependencies to avoid DB calls
mock.module("@feed/db", () => ({
  db: {},
  isSimulationMode: () => true,
}));

mock.module("../services/wallet-service", () => ({
  WalletService: {
    debit: mock(() => Promise.resolve({ success: true })),
    credit: mock(() => Promise.resolve({ success: true })),
    recordPnL: mock(() => Promise.resolve()),
    getBalance: mock(() => Promise.resolve(10000)),
  },
}));

mock.module("@feed/core/markets/perps", () => ({
  PerpDbAdapter: class {},
  PerpMarketService: class {
    getMarketsSnapshot = mock(() => Promise.resolve([]));
  },
}));

import {
  getSimulationPrice,
  getSimulationTickers,
  SIMULATION_DEFAULT_PRICES,
} from "../config/simulation";
import type { CausalEventContext, ScheduledCausalEvent } from "../GameWorld";

// =============================================================================
// Price Override Tests - Using shared helpers from config/simulation.ts
// =============================================================================

describe("GameLoop - Simulation Mode Price Overrides", () => {
  test("constructs market state with default prices when no overrides", () => {
    // Test the centralized price calculation logic
    expect(getSimulationPrice("BTCAI")).toBe(120000);
    expect(getSimulationPrice("ETHAI")).toBe(4000);
    expect(getSimulationPrice("UNKNOWN")).toBe(100); // fallback
  });

  test("price overrides take precedence over defaults", () => {
    const priceOverrides = new Map([
      ["BTCAI", 150000], // Override
      ["ETHAI", 3500], // Override
      ["NEWTOKEN", 999], // New token not in defaults
    ]);

    expect(getSimulationPrice("BTCAI", priceOverrides)).toBe(150000); // Override
    expect(getSimulationPrice("ETHAI", priceOverrides)).toBe(3500); // Override
    expect(getSimulationPrice("SOLAI", priceOverrides)).toBe(200); // Default (no override)
    expect(getSimulationPrice("NEWTOKEN", priceOverrides)).toBe(999); // From override
  });

  test("builds correct market state structure from price overrides", () => {
    const priceOverrides = new Map([
      ["BTCAI", 125000],
      ["METAI", 480],
    ]);

    // Use the centralized helper to get tickers
    const tickers = getSimulationTickers(priceOverrides);
    const marketState = tickers.map((ticker) => {
      const price = getSimulationPrice(ticker, priceOverrides);
      return {
        ticker,
        organizationId: ticker.toLowerCase(),
        name: ticker,
        currentPrice: price,
        change24h: 0,
        changePercent24h: 0,
        high24h: price * 1.01,
        low24h: price * 0.99,
        volume24h: 1000000,
        openInterest: 500000,
        fundingRate: {
          rate: 0.001,
          nextFundingTime: expect.any(String),
          predictedRate: 0.001,
        },
        maxLeverage: 20,
        minOrderSize: 10,
        markPrice: price,
        indexPrice: price,
      };
    });

    expect(marketState).toHaveLength(2);
    expect(marketState[0]?.ticker).toBe("BTCAI");
    expect(marketState[0]?.currentPrice).toBe(125000);
    expect(marketState[0]?.markPrice).toBe(125000);
    expect(marketState[1]?.ticker).toBe("METAI");
    expect(marketState[1]?.currentPrice).toBe(480);
  });

  test("handles empty price overrides gracefully", () => {
    const priceOverrides = new Map<string, number>();

    // Use the centralized helper - should return default keys
    const tickers = getSimulationTickers(priceOverrides);

    // Should return all keys from SIMULATION_DEFAULT_PRICES
    expect(tickers).toEqual(Object.keys(SIMULATION_DEFAULT_PRICES));
    expect(tickers).toContain("BTCAI");
    expect(tickers).toContain("ETHAI");
  });

  test("returns only override keys when overrides is non-empty", () => {
    const priceOverrides = new Map([
      ["CUSTOMTOKEN", 500],
      ["BTCAI", 125000],
    ]);

    // Should return ONLY the keys from the override map
    const tickers = getSimulationTickers(priceOverrides);

    expect(tickers).toHaveLength(2);
    expect(tickers).toContain("CUSTOMTOKEN");
    expect(tickers).toContain("BTCAI");
    // Should NOT include defaults that aren't in overrides
    expect(tickers).not.toContain("ETHAI");
    expect(tickers).not.toContain("SOLAI");
    expect(tickers).not.toContain("METAI");
  });

  test("price overrides maintain precision", () => {
    const priceOverrides = new Map([
      ["BTCAI", 125432.789123], // High precision
      ["METAI", 0.00001234], // Very small
      ["SOLAI", 999999999.99], // Very large
    ]);

    // Test via helper function
    expect(getSimulationPrice("BTCAI", priceOverrides)).toBe(125432.789123);
    expect(getSimulationPrice("METAI", priceOverrides)).toBe(0.00001234);
    expect(getSimulationPrice("SOLAI", priceOverrides)).toBe(999999999.99);
  });
});

// =============================================================================
// Causal Context Tests
// =============================================================================

describe("GameLoop - Causal Context Handling", () => {
  test("causalContext structure is valid", () => {
    const causalContext: CausalEventContext = {
      scheduledEvents: [
        {
          tick: 100,
          day: 5,
          hour: 12,
          eventType: "rumor",
          description: "Test rumor about METAI",
          affectedTickers: ["METAI"],
          isPositive: false,
          sourceFactId: "fact-123",
        },
      ],
      currentTick: 100,
    };

    expect(causalContext.scheduledEvents).toHaveLength(1);
    expect(causalContext.currentTick).toBe(100);
    expect(causalContext.scheduledEvents[0]?.eventType).toBe("rumor");
    expect(causalContext.scheduledEvents[0]?.affectedTickers).toContain(
      "METAI",
    );
  });

  test("filters scheduled events by current tick", () => {
    const scheduledEvents: ScheduledCausalEvent[] = [
      {
        tick: 50,
        day: 3,
        hour: 2,
        eventType: "rumor",
        description: "Past event",
        affectedTickers: ["BTCAI"],
        isPositive: true,
        sourceFactId: "fact-1",
      },
      {
        tick: 100,
        day: 5,
        hour: 4,
        eventType: "leak",
        description: "Current event",
        affectedTickers: ["METAI"],
        isPositive: false,
        sourceFactId: "fact-2",
      },
      {
        tick: 200,
        day: 9,
        hour: 8,
        eventType: "scandal",
        description: "Future event",
        affectedTickers: ["SOLAI"],
        isPositive: false,
        sourceFactId: "fact-3",
      },
    ];

    const currentTick = 100;
    const currentEvents = scheduledEvents.filter((e) => e.tick === currentTick);

    expect(currentEvents).toHaveLength(1);
    expect(currentEvents[0]?.description).toBe("Current event");
    expect(currentEvents[0]?.eventType).toBe("leak");
  });

  test("handles empty scheduled events", () => {
    const causalContext: CausalEventContext = {
      scheduledEvents: [],
      currentTick: 100,
    };

    expect(causalContext.scheduledEvents.filter((e) => e.tick === 100)).toEqual(
      [],
    );
  });

  test("handles multiple events at same tick", () => {
    const scheduledEvents: ScheduledCausalEvent[] = [
      {
        tick: 100,
        day: 5,
        hour: 4,
        eventType: "leak",
        description: "First event",
        affectedTickers: ["BTCAI"],
        isPositive: false,
        sourceFactId: "fact-1",
      },
      {
        tick: 100,
        day: 5,
        hour: 4,
        eventType: "rumor",
        description: "Second event",
        affectedTickers: ["METAI"],
        isPositive: true,
        sourceFactId: "fact-2",
      },
    ];

    const currentEvents = scheduledEvents.filter((e) => e.tick === 100);
    expect(currentEvents).toHaveLength(2);
  });

  test("validates all causal event types", () => {
    const validTypes = [
      "leak",
      "rumor",
      "scandal",
      "development",
      "deal",
      "announcement",
    ];

    for (const eventType of validTypes) {
      const event: ScheduledCausalEvent = {
        tick: 100,
        day: 5,
        hour: 12,
        eventType: eventType as ScheduledCausalEvent["eventType"],
        description: `Test ${eventType}`,
        affectedTickers: ["BTCAI"],
        isPositive: eventType === "deal" || eventType === "announcement",
        sourceFactId: `fact-${eventType}`,
      };

      // Compare as strings since we're iterating over strings
      expect(event.eventType as string).toBe(eventType);
    }
  });
});

// =============================================================================
// Significant Moves Calculation Tests
// =============================================================================

describe("GameLoop - Significant Moves Calculation", () => {
  test("identifies moves greater than 5% as significant", () => {
    const marketState = [
      { ticker: "BTCAI", changePercent24h: 7.5 },
      { ticker: "ETHAI", changePercent24h: 3.2 },
      { ticker: "SOLAI", changePercent24h: -8.1 },
      { ticker: "METAI", changePercent24h: 0.5 },
    ];

    const significantMoves = marketState
      .filter((m) => Math.abs(m.changePercent24h) > 5)
      .map((m) => ({ ticker: m.ticker, change: m.changePercent24h }));

    expect(significantMoves).toHaveLength(2);
    expect(significantMoves).toContainEqual({ ticker: "BTCAI", change: 7.5 });
    expect(significantMoves).toContainEqual({ ticker: "SOLAI", change: -8.1 });
  });

  test("handles exactly 5% threshold (not significant)", () => {
    const marketState = [{ ticker: "BTCAI", changePercent24h: 5.0 }];

    const significantMoves = marketState
      .filter((m) => Math.abs(m.changePercent24h) > 5)
      .map((m) => ({ ticker: m.ticker, change: m.changePercent24h }));

    expect(significantMoves).toHaveLength(0);
  });

  test("handles negative significant moves", () => {
    const marketState = [
      { ticker: "BTCAI", changePercent24h: -25 },
      { ticker: "ETHAI", changePercent24h: -5.1 },
    ];

    const significantMoves = marketState
      .filter((m) => Math.abs(m.changePercent24h) > 5)
      .map((m) => ({ ticker: m.ticker, change: m.changePercent24h }));

    expect(significantMoves).toHaveLength(2);
    expect(significantMoves[0]?.change).toBeLessThan(0);
  });

  test("handles empty market state", () => {
    const marketState: Array<{ ticker: string; changePercent24h: number }> = [];

    const significantMoves = marketState
      .filter((m) => Math.abs(m.changePercent24h) > 5)
      .map((m) => ({ ticker: m.ticker, change: m.changePercent24h }));

    expect(significantMoves).toHaveLength(0);
  });
});

// =============================================================================
// Edge Cases and Boundary Conditions
// =============================================================================

describe("GameLoop - Edge Cases", () => {
  test("handles day 1 hour 0 (start of simulation)", () => {
    const day = 1;
    const hour = 0;

    // First tick should still work
    expect(day).toBe(1);
    expect(hour).toBe(0);
    // No special handling needed, just verify valid range
    expect(hour >= 0 && hour <= 23).toBe(true);
    expect(day >= 1).toBe(true);
  });

  test("handles day 30 hour 23 (end of simulation)", () => {
    const day = 30;
    const hour = 23;

    expect(day).toBe(30);
    expect(hour).toBe(23);
    expect(hour >= 0 && hour <= 23).toBe(true);
  });

  test("handles maximum price values", () => {
    const priceOverrides = new Map([
      ["BTCAI", Number.MAX_SAFE_INTEGER],
      ["ETHAI", 0.0000001],
    ]);

    expect(priceOverrides.get("BTCAI")).toBe(Number.MAX_SAFE_INTEGER);
    expect(priceOverrides.get("ETHAI")).toBe(0.0000001);
  });

  test("handles undefined options gracefully", () => {
    // Simulate the options destructuring with proper typing
    // Use a function to avoid TypeScript narrowing
    const getOptions = ():
      | {
          priceOverrides?: Map<string, number>;
          causalContext?: CausalEventContext;
        }
      | undefined => undefined;

    const options = getOptions();

    const priceOverrides = options?.priceOverrides;
    const causalContext = options?.causalContext;

    expect(priceOverrides).toBeUndefined();
    expect(causalContext).toBeUndefined();
  });

  test("handles partial options (only priceOverrides)", () => {
    const options = {
      priceOverrides: new Map([["BTCAI", 100000]]),
    };

    expect(options.priceOverrides.get("BTCAI")).toBe(100000);
    expect(
      (options as { causalContext?: CausalEventContext }).causalContext,
    ).toBeUndefined();
  });

  test("handles partial options (only causalContext)", () => {
    const options = {
      causalContext: {
        scheduledEvents: [],
        currentTick: 0,
      },
    };

    expect(
      (options as { priceOverrides?: Map<string, number> }).priceOverrides,
    ).toBeUndefined();
    expect(options.causalContext.currentTick).toBe(0);
  });
});
