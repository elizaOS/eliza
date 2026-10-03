/**
 * Deterministic tests of the pure terminal price-alert list: creation rules,
 * one-shot triggering against live prices, missing prices, the OFF pause
 * rule, and parsing of stored records.
 */
import { describe, expect, it } from "vitest";
import {
  addPriceAlert,
  alertsActive,
  checkPriceAlerts,
  createPriceAlertState,
  type PriceAlertInput,
  type PriceAlertState,
  parsePriceAlerts,
  removePriceAlert,
} from "./price-alerts";

const solAbove = (targetUsd: number): PriceAlertInput => ({
  assetId: "solana",
  symbol: "SOL",
  direction: "above",
  targetUsd,
  currentUsd: 150,
});

function withAlert(input: PriceAlertInput, id = "a1"): PriceAlertState {
  const added = addPriceAlert(createPriceAlertState(), input, id, 1_000);
  if (!added.ok) throw new Error(`fixture alert rejected: ${added.reason}`);
  return added.state;
}

describe("addPriceAlert", () => {
  it("adds a waiting alert newest first", () => {
    const first = withAlert(solAbove(160), "a1");
    const second = addPriceAlert(
      first,
      { ...solAbove(140), direction: "below" },
      "a2",
      2_000,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.alerts.map((alert) => alert.id)).toEqual(["a2", "a1"]);
    expect(second.alert).toMatchObject({
      direction: "below",
      targetUsd: 140,
      createdAt: 2_000,
      triggeredAt: null,
      triggeredPriceUsd: null,
    });
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a target of %s",
    (targetUsd) => {
      expect(
        addPriceAlert(createPriceAlertState(), solAbove(targetUsd), "a", 0),
      ).toEqual({ ok: false, reason: "invalid-price" });
    },
  );

  it("refuses a condition the live price already meets", () => {
    const state = createPriceAlertState();
    expect(addPriceAlert(state, solAbove(150), "a", 0)).toEqual({
      ok: false,
      reason: "already-met",
    });
    expect(
      addPriceAlert(state, { ...solAbove(155), direction: "below" }, "b", 0),
    ).toEqual({ ok: false, reason: "already-met" });
  });
});

describe("checkPriceAlerts", () => {
  it("fires once when the live price reaches the target", () => {
    const state = withAlert(solAbove(160));
    const below = checkPriceAlerts(state, new Map([["solana", 159.99]]), 5_000);
    expect(below.triggered).toEqual([]);
    expect(below.state).toBe(state);

    const hit = checkPriceAlerts(state, new Map([["solana", 161.5]]), 6_000);
    expect(hit.triggered).toHaveLength(1);
    expect(hit.triggered[0]).toMatchObject({
      id: "a1",
      triggeredAt: 6_000,
      triggeredPriceUsd: 161.5,
    });

    const again = checkPriceAlerts(
      hit.state,
      new Map([["solana", 170]]),
      7_000,
    );
    expect(again.triggered).toEqual([]);
    expect(again.state.alerts[0]?.triggeredAt).toBe(6_000);
  });

  it("fires a below alert at or under its target", () => {
    const state = withAlert({ ...solAbove(140), direction: "below" });
    const hit = checkPriceAlerts(state, new Map([["solana", 140]]), 1);
    expect(hit.triggered.map((alert) => alert.id)).toEqual(["a1"]);
  });

  it("leaves an alert waiting when its asset has no usable live price", () => {
    const state = withAlert(solAbove(160));
    expect(
      checkPriceAlerts(state, new Map([["bitcoin", 1e9]]), 1).triggered,
    ).toEqual([]);
    expect(
      checkPriceAlerts(state, new Map([["solana", Number.NaN]]), 1).triggered,
    ).toEqual([]);
  });
});

describe("removePriceAlert and alertsActive", () => {
  it("removes by id", () => {
    expect(removePriceAlert(withAlert(solAbove(160)), "a1").alerts).toEqual([]);
  });

  it("pauses alerts only in OFF", () => {
    expect(alertsActive("hunt")).toBe(true);
    expect(alertsActive("sleep")).toBe(true);
    expect(alertsActive("off")).toBe(false);
  });
});

describe("parsePriceAlerts", () => {
  it("starts empty when nothing is stored and round-trips a saved list", () => {
    expect(parsePriceAlerts(null)).toEqual({
      status: "empty",
      state: createPriceAlertState(),
    });
    const fired = checkPriceAlerts(
      withAlert(solAbove(160)),
      new Map([["solana", 165]]),
      9_000,
    ).state;
    expect(parsePriceAlerts(JSON.stringify(fired))).toEqual({
      status: "ok",
      state: fired,
    });
  });

  it.each([
    ["{broken", /not valid JSON/],
    [JSON.stringify({ version: 2, alerts: [] }), /unexpected shape/],
    [
      JSON.stringify({
        version: 1,
        alerts: [{ ...withAlert(solAbove(160)).alerts[0], direction: "up" }],
      }),
      /unexpected shape/,
    ],
    [
      JSON.stringify({
        version: 1,
        alerts: [{ ...withAlert(solAbove(160)).alerts[0], targetUsd: -1 }],
      }),
      /unexpected shape/,
    ],
  ])("reports an unreadable record (%s) and starts empty", (raw, error) => {
    const parsed = parsePriceAlerts(raw);
    expect(parsed.status).toBe("invalid");
    expect(parsed.state).toEqual(createPriceAlertState());
    if (parsed.status === "invalid") expect(parsed.error).toMatch(error);
  });
});
