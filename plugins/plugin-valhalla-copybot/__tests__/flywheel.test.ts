import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits.ts";
import { computeTicketSol, splitWaveProfit, tradeableSol } from "../src/slots.ts";

/**
 * These pin the money math of the compounding flywheel. A silent change here
 * changes position size, so each case states the economics it depends on.
 */
describe("compounding flywheel", () => {
  it("keeps a constant ticket when the cap equals the floor", () => {
    expect(LIMITS.ticketSolFloor).toBe(LIMITS.ticketSolMax);
    const small = computeTicketSol(0.5, 0, false, LIMITS);
    const large = computeTicketSol(50, 1, false, LIMITS);
    expect(small).toBe(LIMITS.ticketSolFloor);
    expect(large).toBe(LIMITS.ticketSolFloor);
  });

  it("grows the ticket with equity once the cap is above the floor", () => {
    const limits = { ...LIMITS, ticketSolMax: 0.25 };
    const one = computeTicketSol(1, 0, false, limits);
    const ten = computeTicketSol(10, 0, false, limits);
    const capped = computeTicketSol(1_000, 0, false, limits);
    expect(ten).toBeGreaterThan(one);
    expect(capped).toBe(0.25);
    expect(capped).toBeLessThanOrEqual(limits.ticketSolMax);
  });

  it("never creates SOL when a wave is split", () => {
    const win = splitWaveProfit(1, 5, LIMITS);
    expect(win.reinvest + win.reserve + win.net).toBeCloseTo(1, 10);
    expect(win.mode).toBe("at_principal");
    const below = splitWaveProfit(1, 0.1, LIMITS);
    expect(below.reinvest + below.reserve + below.net).toBeCloseTo(1, 10);
    expect(below.mode).toBe("below_principal");
    expect(splitWaveProfit(-1, 5, LIMITS)).toEqual({
      reinvest: 0,
      reserve: 0,
      net: 0,
      mode: "flat",
    });
  });

  it("keeps the fee reserve out of the tradeable amount", () => {
    expect(tradeableSol(1, 0.4, 0.25, LIMITS)).toBeCloseTo(
      1 - 0.4 - 0.25 - LIMITS.feeReserveSol,
      10
    );
    expect(tradeableSol(0.1, 1, 1, LIMITS)).toBe(0);
  });
});
