import { describe, expect, it } from "vitest";
import { createDefaultCircadianInsightContract } from "./circadian-default";

describe("createDefaultCircadianInsightContract", () => {
  it("reports an uncalibrated sleep window with no fabricated values", async () => {
    const contract = createDefaultCircadianInsightContract();
    const window = await contract.getCurrentSleepWindow();
    expect(window).toEqual({
      state: null,
      confidence: 0,
      lastWakeAtIso: null,
      currentSleepStartedAtIso: null,
      bedtimeTargetAtIso: null,
    });
  });

  it("reports an uncalibrated scheduling window with an explicit reason", async () => {
    const contract = createDefaultCircadianInsightContract();
    const window = await contract.inferOptimalSchedulingWindow();
    expect(window).toEqual({
      recommendedAtIso: null,
      nextMealLabel: null,
      windowStartIso: null,
      windowEndIso: null,
      confidence: 0,
      reason: "circadian inference not calibrated",
    });
  });

  it("returns no latest insight until a richer implementation is registered", async () => {
    const contract = createDefaultCircadianInsightContract();
    await expect(contract.getLatestInsight()).resolves.toBeNull();
  });

  it("keeps all contract methods async", () => {
    const contract = createDefaultCircadianInsightContract();
    expect(contract.getCurrentSleepWindow()).toBeInstanceOf(Promise);
    expect(contract.inferOptimalSchedulingWindow()).toBeInstanceOf(Promise);
    expect(contract.getLatestInsight()).toBeInstanceOf(Promise);
  });
});
