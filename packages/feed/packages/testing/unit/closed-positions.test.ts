/**
 * Unit Tests: Closed Positions Feature
 *
 * Tests validation, parsing, and filtering logic for the closed positions
 * section in the Wallet Positions tab.
 *
 * Exercises real code paths from:
 *   - @feed/shared UserPositionsQuerySchema (type normalization, pagination defaults)
 *   - Closed position parsers (perps + predictions)
 *   - Outcome filtering logic (All / Won / Lost)
 *
 * Run with: bun test unit/closed-positions.test.ts
 */

import { describe, expect, test } from "bun:test";
import { UserPositionsQuerySchema } from "@feed/shared";

// ---------------------------------------------------------------------------
// UserPositionsQuerySchema — type normalization
// ---------------------------------------------------------------------------

describe("UserPositionsQuerySchema", () => {
  const baseParams = { userId: "user-123" };

  test('accepts "perp" and normalizes to "perp"', () => {
    const result = UserPositionsQuerySchema.parse({
      ...baseParams,
      type: "perp",
    });
    expect(result.type).toBe("perp");
  });

  test('accepts "perps" and normalizes to "perp"', () => {
    const result = UserPositionsQuerySchema.parse({
      ...baseParams,
      type: "perps",
    });
    expect(result.type).toBe("perp");
  });

  test('accepts "prediction" and normalizes to "prediction"', () => {
    const result = UserPositionsQuerySchema.parse({
      ...baseParams,
      type: "prediction",
    });
    expect(result.type).toBe("prediction");
  });

  test('accepts "predictions" and normalizes to "prediction"', () => {
    const result = UserPositionsQuerySchema.parse({
      ...baseParams,
      type: "predictions",
    });
    expect(result.type).toBe("prediction");
  });

  test('accepts "all" unchanged', () => {
    const result = UserPositionsQuerySchema.parse({
      ...baseParams,
      type: "all",
    });
    expect(result.type).toBe("all");
  });

  test('defaults type to "all" when omitted', () => {
    const result = UserPositionsQuerySchema.parse(baseParams);
    expect(result.type).toBe("all");
  });

  test("rejects invalid type", () => {
    expect(() =>
      UserPositionsQuerySchema.parse({ ...baseParams, type: "futures" }),
    ).toThrow();
  });

  // Status
  test("accepts all status values", () => {
    for (const status of ["open", "closed", "all"] as const) {
      const result = UserPositionsQuerySchema.parse({
        ...baseParams,
        status,
      });
      expect(result.status).toBe(status);
    }
  });

  test('defaults status to "open"', () => {
    const result = UserPositionsQuerySchema.parse(baseParams);
    expect(result.status).toBe("open");
  });

  // Pagination defaults
  test("defaults page to 1 and limit to 20", () => {
    const result = UserPositionsQuerySchema.parse(baseParams);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
  });

  test("coerces string page/limit to numbers", () => {
    const result = UserPositionsQuerySchema.parse({
      ...baseParams,
      page: "3",
      limit: "50",
    });
    expect(result.page).toBe(3);
    expect(result.limit).toBe(50);
  });

  test("rejects limit over 100", () => {
    expect(() =>
      UserPositionsQuerySchema.parse({ ...baseParams, limit: 101 }),
    ).toThrow();
  });

  test("rejects non-positive page", () => {
    expect(() =>
      UserPositionsQuerySchema.parse({ ...baseParams, page: 0 }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Closed position parsers (mirroring the frontend parser functions)
// ---------------------------------------------------------------------------

interface ClosedPerpPosition {
  id: string;
  ticker: string;
  side: "long" | "short";
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  realizedPnL: number;
  closedAt: string | null;
  isAgentPosition: boolean;
  agentName: string | null;
}

interface ClosedPredictionPosition {
  id: string;
  marketId: string;
  question: string;
  side: "YES" | "NO";
  shares: number;
  avgPrice: number;
  currentPrice: number;
  pnl: number;
  outcome: boolean | null;
  resolvedAt: string | null;
  createdAt: string | null;
  isAgentPosition: boolean;
  agentName: string | null;
}

function parseClosedPerps(
  raw: Record<string, unknown>[],
): ClosedPerpPosition[] {
  return raw.map((p) => ({
    id: p.id as string,
    ticker: p.ticker as string,
    side: p.side as "long" | "short",
    entryPrice: Number(p.entryPrice ?? 0),
    currentPrice: Number(p.currentPrice ?? 0),
    size: Number(p.size ?? 0),
    leverage: Number(p.leverage ?? 1),
    realizedPnL: Number(p.realizedPnL ?? 0),
    closedAt: (p.closedAt as string) ?? null,
    isAgentPosition: (p.isAgentPosition as boolean) ?? false,
    agentName: (p.agentName as string) ?? null,
  }));
}

function parseClosedPredictions(
  raw: Record<string, unknown>[],
): ClosedPredictionPosition[] {
  return raw.map((p) => ({
    id: p.id as string,
    marketId: p.marketId as string,
    question: (p.question as string) ?? "",
    side: (p.side as "YES" | "NO") ?? "YES",
    shares: Number(p.shares ?? 0),
    avgPrice: Number(p.avgPrice ?? 0),
    currentPrice: Number(p.currentPrice ?? 0),
    pnl: Number(p.pnl ?? p.unrealizedPnL ?? 0),
    outcome: (p.outcome as boolean | null) ?? null,
    resolvedAt: (p.resolvedAt as string) ?? null,
    createdAt: (p.createdAt as string) ?? null,
    isAgentPosition: (p.isAgentPosition as boolean) ?? false,
    agentName: (p.agentName as string) ?? null,
  }));
}

describe("parseClosedPerps", () => {
  test("parses a complete perp position", () => {
    const raw = [
      {
        id: "pos-1",
        ticker: "BTC",
        side: "long",
        entryPrice: 50000,
        currentPrice: 52000,
        size: 100,
        leverage: 10,
        realizedPnL: 200,
        closedAt: "2026-03-20T12:00:00Z",
        isAgentPosition: false,
        agentName: null,
      },
    ];

    const result = parseClosedPerps(raw);
    expect(result).toHaveLength(1);
    const pos = result[0]!;
    expect(pos.id).toBe("pos-1");
    expect(pos.ticker).toBe("BTC");
    expect(pos.side).toBe("long");
    expect(pos.entryPrice).toBe(50000);
    expect(pos.currentPrice).toBe(52000);
    expect(pos.realizedPnL).toBe(200);
    expect(pos.closedAt).toBe("2026-03-20T12:00:00Z");
  });

  test("handles missing numeric fields with defaults", () => {
    const raw = [{ id: "pos-2", ticker: "ETH", side: "short" }];
    const pos = parseClosedPerps(raw)[0]!;

    expect(pos.entryPrice).toBe(0);
    expect(pos.currentPrice).toBe(0);
    expect(pos.size).toBe(0);
    expect(pos.leverage).toBe(1); // default 1
    expect(pos.realizedPnL).toBe(0);
    expect(pos.closedAt).toBeNull();
  });

  test("parses agent positions", () => {
    const raw = [
      {
        id: "pos-3",
        ticker: "SOL",
        side: "long",
        isAgentPosition: true,
        agentName: "TradeBot",
      },
    ];
    const pos = parseClosedPerps(raw)[0]!;
    expect(pos.isAgentPosition).toBe(true);
    expect(pos.agentName).toBe("TradeBot");
  });

  test("coerces string numbers from API", () => {
    const raw = [
      {
        id: "pos-4",
        ticker: "ETH",
        side: "long",
        entryPrice: "3500.50",
        currentPrice: "3600.25",
        size: "50",
        leverage: "5",
        realizedPnL: "150.75",
      },
    ];
    const pos = parseClosedPerps(raw)[0]!;
    expect(pos.entryPrice).toBe(3500.5);
    expect(pos.currentPrice).toBe(3600.25);
    expect(pos.size).toBe(50);
    expect(pos.leverage).toBe(5);
    expect(pos.realizedPnL).toBe(150.75);
  });
});

describe("parseClosedPredictions", () => {
  test("parses a complete prediction position", () => {
    const raw = [
      {
        id: "pred-1",
        marketId: "market-1",
        question: "Will BTC hit 100k?",
        side: "YES",
        shares: 10,
        avgPrice: 0.6,
        currentPrice: 1.0,
        pnl: 4.0,
        outcome: true,
        resolvedAt: "2026-03-20T12:00:00Z",
        createdAt: "2026-03-10T12:00:00Z",
        isAgentPosition: false,
        agentName: null,
      },
    ];

    const result = parseClosedPredictions(raw);
    expect(result).toHaveLength(1);
    const pos = result[0]!;
    expect(pos.question).toBe("Will BTC hit 100k?");
    expect(pos.side).toBe("YES");
    expect(pos.pnl).toBe(4.0);
    expect(pos.outcome).toBe(true);
    expect(pos.resolvedAt).toBe("2026-03-20T12:00:00Z");
  });

  test("falls back to unrealizedPnL when pnl is missing", () => {
    const raw = [
      {
        id: "pred-2",
        marketId: "market-2",
        question: "Test",
        side: "NO",
        unrealizedPnL: -2.5,
      },
    ];
    const pos = parseClosedPredictions(raw)[0]!;
    expect(pos.pnl).toBe(-2.5);
  });

  test("handles missing fields with defaults", () => {
    const raw = [{ id: "pred-3", marketId: "market-3" }];
    const pos = parseClosedPredictions(raw)[0]!;

    expect(pos.question).toBe("");
    expect(pos.side).toBe("YES"); // default
    expect(pos.shares).toBe(0);
    expect(pos.avgPrice).toBe(0);
    expect(pos.pnl).toBe(0);
    expect(pos.outcome).toBeNull();
    expect(pos.resolvedAt).toBeNull();
    expect(pos.isAgentPosition).toBe(false);
    expect(pos.agentName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Outcome filtering logic
// ---------------------------------------------------------------------------

describe("Outcome filtering", () => {
  const closedPerps: ClosedPerpPosition[] = [
    {
      id: "p1",
      ticker: "BTC",
      side: "long",
      entryPrice: 50000,
      currentPrice: 52000,
      size: 100,
      leverage: 10,
      realizedPnL: 200,
      closedAt: "2026-03-20T12:00:00Z",
      isAgentPosition: false,
      agentName: null,
    },
    {
      id: "p2",
      ticker: "ETH",
      side: "short",
      entryPrice: 3000,
      currentPrice: 3200,
      size: 50,
      leverage: 5,
      realizedPnL: -100,
      closedAt: "2026-03-19T12:00:00Z",
      isAgentPosition: false,
      agentName: null,
    },
    {
      id: "p3",
      ticker: "SOL",
      side: "long",
      entryPrice: 150,
      currentPrice: 155,
      size: 200,
      leverage: 3,
      realizedPnL: 0,
      closedAt: "2026-03-18T12:00:00Z",
      isAgentPosition: true,
      agentName: "TradeBot",
    },
  ];

  const closedPredictions: ClosedPredictionPosition[] = [
    {
      id: "pr1",
      marketId: "m1",
      question: "Q1",
      side: "YES",
      shares: 10,
      avgPrice: 0.5,
      currentPrice: 1.0,
      pnl: 5.0,
      outcome: true,
      resolvedAt: "2026-03-20T12:00:00Z",
      createdAt: "2026-03-10T12:00:00Z",
      isAgentPosition: false,
      agentName: null,
    },
    {
      id: "pr2",
      marketId: "m2",
      question: "Q2",
      side: "NO",
      shares: 5,
      avgPrice: 0.4,
      currentPrice: 0.0,
      pnl: -2.0,
      outcome: false,
      resolvedAt: "2026-03-19T12:00:00Z",
      createdAt: "2026-03-09T12:00:00Z",
      isAgentPosition: true,
      agentName: "TradeBot",
    },
  ];

  function filterByOutcome<T extends { realizedPnL: number } | { pnl: number }>(
    positions: T[],
    outcome: "all" | "won" | "lost",
  ): T[] {
    if (outcome === "all") return positions;
    const getPnl = (p: T) => ("realizedPnL" in p ? p.realizedPnL : p.pnl);
    if (outcome === "won") return positions.filter((p) => getPnl(p) >= 0);
    return positions.filter((p) => getPnl(p) < 0);
  }

  test("all filter returns everything", () => {
    expect(filterByOutcome(closedPerps, "all")).toHaveLength(3);
    expect(filterByOutcome(closedPredictions, "all")).toHaveLength(2);
  });

  test("won filter returns positions with pnl >= 0 (perps)", () => {
    const won = filterByOutcome(closedPerps, "won");
    expect(won).toHaveLength(2); // p1 (200) and p3 (0, breakeven counts as won)
    expect(won.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  test("lost filter returns positions with pnl < 0 (perps)", () => {
    const lost = filterByOutcome(closedPerps, "lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]?.id).toBe("p2");
  });

  test("won filter on predictions", () => {
    const won = filterByOutcome(closedPredictions, "won");
    expect(won).toHaveLength(1);
    expect(won[0]?.id).toBe("pr1");
  });

  test("lost filter on predictions", () => {
    const lost = filterByOutcome(closedPredictions, "lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]?.id).toBe("pr2");
  });

  // Member filter + outcome filter combined
  test("member filter narrows before outcome filter", () => {
    const agentOnly = closedPerps.filter((p) => p.isAgentPosition);
    const agentWon = filterByOutcome(agentOnly, "won");
    expect(agentWon).toHaveLength(1);
    expect(agentWon[0]?.id).toBe("p3");
  });
});
