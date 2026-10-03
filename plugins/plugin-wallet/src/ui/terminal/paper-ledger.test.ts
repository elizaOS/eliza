/**
 * Exercises the real paper-trading ledger: fills, reservations, limit
 * settlement, cancellation, valuation with missing prices, and parsing of
 * tampered persisted state. Pure and deterministic; no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  availableCashUsd,
  availableUnits,
  cancelPaperOrder,
  createPaperLedger,
  type PaperAsset,
  type PaperLedger,
  parsePaperLedger,
  placePaperOrder,
  previewPaperOrder,
  settleOpenPaperOrders,
  valuePaperLedger,
} from "./paper-ledger";

const btc: PaperAsset = { id: "bitcoin", symbol: "BTC", priceUsd: 50_000 };
const eth: PaperAsset = { id: "ethereum", symbol: "ETH", priceUsd: 2_000 };

function buy(ledger: PaperLedger, amount: number, asset = btc) {
  return placePaperOrder(
    ledger,
    { asset, side: "buy", type: "market", amount },
    `buy-${amount}`,
    1,
  ).ledger;
}

describe("paper market orders", () => {
  it("fills a buy at the live price and debits cash", () => {
    const { ledger, order } = placePaperOrder(
      createPaperLedger(10_000),
      { asset: btc, side: "buy", type: "market", amount: 5_000 },
      "o1",
      100,
    );
    expect(order).toMatchObject({
      status: "filled",
      units: 0.1,
      closedAt: 100,
    });
    expect(ledger.cashUsd).toBe(5_000);
    expect(ledger.holdings.bitcoin).toEqual({ symbol: "BTC", units: 0.1 });
  });

  it("sells units back at the live price and drops an emptied holding", () => {
    const bought = buy(createPaperLedger(10_000), 5_000);
    const { ledger } = placePaperOrder(
      bought,
      {
        asset: { ...btc, priceUsd: 60_000 },
        side: "sell",
        type: "market",
        amount: 0.1,
      },
      "o2",
      2,
    );
    expect(ledger.cashUsd).toBe(11_000);
    expect(ledger.holdings.bitcoin).toBeUndefined();
  });

  it.each([
    [{ amount: 0 }, "invalid-amount"],
    [{ amount: Number.NaN }, "invalid-amount"],
    [{ amount: -5 }, "invalid-amount"],
    [{ amount: 10_001 }, "insufficient-cash"],
    [{ amount: 100, type: "limit" as const }, "invalid-price"],
    [
      { amount: 100, type: "limit" as const, limitPriceUsd: 0 },
      "invalid-price",
    ],
  ])("rejects buy %o as %s", (overrides, reason) => {
    expect(
      previewPaperOrder(createPaperLedger(10_000), {
        asset: btc,
        side: "buy",
        type: "market",
        ...overrides,
      }),
    ).toEqual({ ok: false, reason });
  });

  it("rejects selling more than is held", () => {
    expect(
      previewPaperOrder(buy(createPaperLedger(), 1_000), {
        asset: btc,
        side: "sell",
        type: "market",
        amount: 1,
      }),
    ).toEqual({ ok: false, reason: "insufficient-units" });
  });

  it("refuses to place an order that no longer passes review", () => {
    expect(() =>
      placePaperOrder(
        createPaperLedger(100),
        { asset: btc, side: "buy", type: "market", amount: 500 },
        "o3",
        1,
      ),
    ).toThrow(/insufficient-cash/);
  });

  it("rejects a sale of a different asset than is held", () => {
    expect(
      previewPaperOrder(buy(createPaperLedger(), 1_000), {
        asset: eth,
        side: "sell",
        type: "market",
        amount: 0.01,
      }),
    ).toEqual({ ok: false, reason: "insufficient-units" });
  });
});

describe("paper limit orders", () => {
  it("reserves cash for an open buy so it cannot be spent twice", () => {
    const { ledger, order } = placePaperOrder(
      createPaperLedger(10_000),
      {
        asset: btc,
        side: "buy",
        type: "limit",
        amount: 8_000,
        limitPriceUsd: 40_000,
      },
      "l1",
      1,
    );
    expect(order.status).toBe("open");
    expect(ledger.cashUsd).toBe(10_000);
    expect(availableCashUsd(ledger)).toBe(2_000);
    expect(
      previewPaperOrder(ledger, {
        asset: btc,
        side: "buy",
        type: "market",
        amount: 3_000,
      }),
    ).toEqual({ ok: false, reason: "insufficient-cash" });
  });

  it("fills at the limit once the live price crosses, not before", () => {
    const placed = placePaperOrder(
      createPaperLedger(10_000),
      {
        asset: btc,
        side: "buy",
        type: "limit",
        amount: 4_000,
        limitPriceUsd: 40_000,
      },
      "l2",
      1,
    ).ledger;
    const notYet = settleOpenPaperOrders(
      placed,
      new Map([["bitcoin", 41_000]]),
      2,
    );
    expect(notYet.filled).toHaveLength(0);

    const crossed = settleOpenPaperOrders(
      placed,
      new Map([["bitcoin", 39_500]]),
      3,
    );
    expect(crossed.filled).toHaveLength(1);
    expect(crossed.ledger.cashUsd).toBe(6_000);
    expect(crossed.ledger.holdings.bitcoin?.units).toBe(0.1);
    expect(crossed.ledger.orders[0]).toMatchObject({
      status: "filled",
      closedAt: 3,
    });
    expect(
      settleOpenPaperOrders(crossed.ledger, new Map([["bitcoin", 1]]), 4)
        .filled,
    ).toHaveLength(0);
  });

  it("fills an already-marketable limit immediately", () => {
    const { order } = placePaperOrder(
      createPaperLedger(10_000),
      {
        asset: btc,
        side: "buy",
        type: "limit",
        amount: 1_000,
        limitPriceUsd: 55_000,
      },
      "l3",
      1,
    );
    expect(order.status).toBe("filled");
  });

  it("reserves units for an open sell and releases them on cancel", () => {
    const held = buy(createPaperLedger(10_000), 5_000);
    const { ledger, order } = placePaperOrder(
      held,
      {
        asset: btc,
        side: "sell",
        type: "limit",
        amount: 0.06,
        limitPriceUsd: 70_000,
      },
      "l4",
      2,
    );
    expect(availableUnits(ledger, "bitcoin")).toBeCloseTo(0.04);
    const cancelled = cancelPaperOrder(ledger, order.id, 3);
    expect(cancelled.orders[0]).toMatchObject({
      status: "cancelled",
      closedAt: 3,
    });
    expect(availableUnits(cancelled, "bitcoin")).toBeCloseTo(0.1);
    expect(
      settleOpenPaperOrders(cancelled, new Map([["bitcoin", 80_000]]), 4)
        .filled,
    ).toHaveLength(0);
  });
});

describe("paper valuation", () => {
  it("values holdings at live prices", () => {
    const ledger = buy(buy(createPaperLedger(10_000), 5_000), 2_000, eth);
    const valuation = valuePaperLedger(
      ledger,
      new Map([
        ["bitcoin", 60_000],
        ["ethereum", 2_500],
      ]),
    );
    expect(valuation.totalUsd).toBe(3_000 + 6_000 + 2_500);
    expect(valuation.positions.map((position) => position.symbol)).toEqual([
      "BTC",
      "ETH",
    ]);
  });

  it("reports no total while a held asset has no live price", () => {
    const valuation = valuePaperLedger(
      buy(createPaperLedger(10_000), 5_000),
      new Map(),
    );
    expect(valuation.totalUsd).toBeNull();
    expect(valuation.positions[0]).toMatchObject({
      priceUsd: null,
      valueUsd: null,
    });
  });
});

describe("parsePaperLedger", () => {
  it("starts fresh when nothing is stored", () => {
    expect(parsePaperLedger(null)).toEqual({
      status: "empty",
      ledger: createPaperLedger(),
    });
  });

  it("round-trips a ledger with orders", () => {
    const ledger = buy(createPaperLedger(10_000), 5_000);
    expect(parsePaperLedger(JSON.stringify(ledger))).toEqual({
      status: "ok",
      ledger,
    });
  });

  it.each([
    ["{not json", /not valid JSON/],
    ["null", /not an object/],
    [JSON.stringify({ version: 2 }), /unknown version/],
    [
      JSON.stringify({ version: 1, cashUsd: -1, holdings: {}, orders: [] }),
      /cash balance/,
    ],
    [
      JSON.stringify({
        version: 1,
        cashUsd: 1,
        holdings: { bitcoin: { symbol: "BTC", units: "lots" } },
        orders: [],
      }),
      /holding bitcoin/,
    ],
    [
      JSON.stringify({
        version: 1,
        cashUsd: 1,
        holdings: {},
        orders: [{ id: "x", side: "steal" }],
      }),
      /invalid order/,
    ],
  ])("flags tampered storage %s as invalid", (raw, message) => {
    const parsed = parsePaperLedger(raw);
    expect(parsed.status).toBe("invalid");
    if (parsed.status === "invalid") expect(parsed.error).toMatch(message);
  });
});
