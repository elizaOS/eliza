import { describe, expect, it } from "bun:test";
import {
  TRADING_RETURN_CAPITAL_FLOOR,
  TradingPerformanceService,
} from "../../api/src/services/trading-performance-service";

describe("TradingPerformanceService.calculateTradingReturnMetrics", () => {
  it("uses the raw capital base when it is above the floor", () => {
    const result = TradingPerformanceService.calculateTradingReturnMetrics(
      500,
      2000,
    );

    expect(result.capitalBase).toBe(2000);
    expect(result.effectiveCapitalBase).toBe(2000);
    expect(result.tradingReturn).toBe(0.25);
  });

  it("applies the canonical floor when capital base is below 1000", () => {
    const result = TradingPerformanceService.calculateTradingReturnMetrics(
      500,
      300,
    );

    expect(result.capitalBase).toBe(300);
    expect(result.effectiveCapitalBase).toBe(TRADING_RETURN_CAPITAL_FLOOR);
    expect(result.tradingReturn).toBe(0.5);
  });

  it("clamps negative capital base to zero before applying the floor", () => {
    const result = TradingPerformanceService.calculateTradingReturnMetrics(
      -200,
      -50,
    );

    expect(result.capitalBase).toBe(0);
    expect(result.effectiveCapitalBase).toBe(TRADING_RETURN_CAPITAL_FLOOR);
    expect(result.tradingReturn).toBe(-0.2);
  });
});
