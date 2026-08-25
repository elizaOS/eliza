/**
 * Pins the analytics projection math: linear-regression edge cases, the clamps
 * that keep a downward trend from projecting negative usage, confidence decay
 * and its floor, and the alert thresholds — including the guards that keep a
 * zero baseline from producing Infinity/NaN in user-facing copy. The projector
 * is documented as deterministic for a given timestamp, so that is asserted
 * directly. Pure module, no harness.
 */

import { describe, expect, test } from "bun:test";
import {
  calculateLinearRegression,
  generateProjectionAlerts,
  generateProjections,
  PROJECTION_CONSTANTS,
  type ProjectionDataPoint,
} from "./projections";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();

function point(
  index: number,
  over: Partial<{
    totalRequests: number;
    totalCost: number;
    inputTokens: number;
    outputTokens: number;
    successRate: number;
  }> = {},
) {
  return {
    timestamp: new Date(T0 + DAY * index),
    totalRequests: 100,
    totalCost: 1000,
    inputTokens: 500,
    outputTokens: 250,
    successRate: 1,
    ...over,
  } as never;
}

/** `n` points whose metrics follow `f(i)`. */
function series(n: number, f: (i: number) => Record<string, number>) {
  return Array.from({ length: n }, (_, i) => point(i, f(i)));
}

describe("calculateLinearRegression", () => {
  test("returns a zero line for an empty series", () => {
    expect(calculateLinearRegression([])).toEqual({ slope: 0, intercept: 0 });
  });

  test("returns the single value as intercept for one point", () => {
    expect(calculateLinearRegression([42])).toEqual({ slope: 0, intercept: 42 });
    expect(calculateLinearRegression([0])).toEqual({ slope: 0, intercept: 0 });
  });

  test("recovers an exact line", () => {
    const { slope, intercept } = calculateLinearRegression([3, 5, 7, 9, 11]);
    expect(slope).toBeCloseTo(2, 10);
    expect(intercept).toBeCloseTo(3, 10);
  });

  test("recovers an exact decreasing line", () => {
    const { slope, intercept } = calculateLinearRegression([10, 8, 6, 4]);
    expect(slope).toBeCloseTo(-2, 10);
    expect(intercept).toBeCloseTo(10, 10);
  });

  test("gives a flat series zero slope at its level", () => {
    const { slope, intercept } = calculateLinearRegression([7, 7, 7, 7]);
    expect(slope).toBeCloseTo(0, 10);
    expect(intercept).toBeCloseTo(7, 10);
  });

  test("never returns NaN or Infinity for finite input", () => {
    for (const values of [[], [0], [0, 0], [1, 1], [1e12, 1e12, 1e12], [-5, 5]]) {
      const { slope, intercept } = calculateLinearRegression(values);
      expect(Number.isFinite(slope)).toBe(true);
      expect(Number.isFinite(intercept)).toBe(true);
    }
  });

  test("predicts the next value of a known line", () => {
    const { slope, intercept } = calculateLinearRegression([2, 4, 6, 8]);
    expect(intercept + slope * 4).toBeCloseTo(10, 10);
  });
});

describe("generateProjections — passthrough", () => {
  test("returns history unprojected when there are fewer than three points", () => {
    for (const n of [0, 1, 2]) {
      const out = generateProjections(
        series(n, () => ({})),
        5,
      );
      expect(out.length).toBe(n);
      expect(out.every((d) => d.isProjected === false)).toBe(true);
    }
  });

  test("appends exactly `periods` projected points", () => {
    for (const periods of [0, 1, 7, 30]) {
      const out = generateProjections(
        series(5, () => ({})),
        periods,
      );
      expect(out.length).toBe(5 + periods);
      expect(out.filter((d) => d.isProjected).length).toBe(periods);
    }
  });

  test("preserves the historical points ahead of the projected ones", () => {
    const history = series(5, (i) => ({ totalRequests: 100 + i }));
    const out = generateProjections(history, 3);
    for (let i = 0; i < history.length; i += 1) {
      expect(out[i].isProjected).toBe(false);
      expect(out[i].totalRequests).toBe(history[i].totalRequests);
      expect(out[i].timestamp.getTime()).toBe(history[i].timestamp.getTime());
    }
  });
});

describe("generateProjections — clamps", () => {
  test("a steep decline never projects negative usage or cost", () => {
    const history = series(6, (i) => ({
      totalRequests: 1000 - i * 200,
      totalCost: 5000 - i * 1000,
      inputTokens: 900 - i * 180,
      outputTokens: 400 - i * 80,
    }));
    for (const d of generateProjections(history, 20).filter((p) => p.isProjected)) {
      expect(d.totalRequests).toBeGreaterThanOrEqual(0);
      expect(d.totalCost).toBeGreaterThanOrEqual(0);
      expect(d.inputTokens).toBeGreaterThanOrEqual(0);
      expect(d.outputTokens).toBeGreaterThanOrEqual(0);
    }
  });

  test("success rate stays within the 0..1 fraction the source reports", () => {
    const rising = series(6, (i) => ({ successRate: 0.5 + i * 0.2 }));
    const falling = series(6, (i) => ({ successRate: 0.9 - i * 0.3 }));
    for (const history of [rising, falling]) {
      for (const d of generateProjections(history, 15).filter((p) => p.isProjected)) {
        expect(d.successRate).toBeGreaterThanOrEqual(0);
        expect(d.successRate).toBeLessThanOrEqual(1);
      }
    }
  });

  test("projected counts are whole numbers", () => {
    const history = series(5, (i) => ({ totalRequests: 100 + i * 7 }));
    for (const d of generateProjections(history, 6).filter((p) => p.isProjected)) {
      expect(Number.isInteger(d.totalRequests)).toBe(true);
      expect(Number.isInteger(d.totalCost)).toBe(true);
      expect(Number.isInteger(d.inputTokens)).toBe(true);
      expect(Number.isInteger(d.outputTokens)).toBe(true);
    }
  });

  test("projected timestamps advance by the mean historical spacing", () => {
    const history = series(5, () => ({}));
    const projected = generateProjections(history, 4).filter((p) => p.isProjected);
    const last = history[history.length - 1].timestamp.getTime();
    projected.forEach((d, i) => {
      expect(d.timestamp.getTime()).toBe(last + DAY * (i + 1));
    });
  });
});

describe("generateProjections — confidence", () => {
  test("decays by the declared rate and never falls below the floor", () => {
    const projected = generateProjections(
      series(5, () => ({})),
      40,
    ).filter((p) => p.isProjected);
    projected.forEach((d, i) => {
      const expected = Math.max(
        PROJECTION_CONSTANTS.MIN_CONFIDENCE,
        PROJECTION_CONSTANTS.INITIAL_CONFIDENCE -
          (i + 1) * PROJECTION_CONSTANTS.CONFIDENCE_DECAY_RATE,
      );
      expect(d.confidence).toBe(expected);
    });
  });

  test("is monotonically non-increasing", () => {
    const projected = generateProjections(
      series(5, () => ({})),
      30,
    ).filter((p) => p.isProjected);
    for (let i = 1; i < projected.length; i += 1) {
      expect(projected[i].confidence as number).toBeLessThanOrEqual(
        projected[i - 1].confidence as number,
      );
    }
  });

  test("bottoms out exactly at the declared floor", () => {
    const projected = generateProjections(
      series(5, () => ({})),
      60,
    ).filter((p) => p.isProjected);
    const lowest = Math.min(...projected.map((d) => d.confidence as number));
    expect(lowest).toBe(PROJECTION_CONSTANTS.MIN_CONFIDENCE);
  });
});

describe("generateProjections — determinism", () => {
  test("identical input yields identical output", () => {
    const build = () => series(6, (i) => ({ totalRequests: 100 + i * 13 }));
    const a = generateProjections(build(), 10);
    const b = generateProjections(build(), 10);
    expect(a.map((d) => [d.timestamp.getTime(), d.totalRequests, d.totalCost])).toEqual(
      b.map((d) => [d.timestamp.getTime(), d.totalRequests, d.totalCost]),
    );
  });

  test("the applied variance stays within the declared factor", () => {
    // A flat history projects a flat line, so any deviation from the level is
    // exactly the variance multiplier.
    const level = 1_000_000;
    const history = series(6, () => ({ totalRequests: level }));
    for (const d of generateProjections(history, 20).filter((p) => p.isProjected)) {
      const ratio = d.totalRequests / level;
      expect(ratio).toBeGreaterThanOrEqual(1 - PROJECTION_CONSTANTS.VARIANCE_FACTOR / 2);
      expect(ratio).toBeLessThanOrEqual(1 + PROJECTION_CONSTANTS.VARIANCE_FACTOR / 2);
    }
  });
});

describe("generateProjectionAlerts", () => {
  const projected = (over: Partial<ProjectionDataPoint>[]): ProjectionDataPoint[] =>
    over.map(
      (o, i) =>
        ({
          timestamp: new Date(T0 + DAY * (100 + i)),
          totalRequests: 0,
          totalCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          successRate: 1,
          isProjected: true,
          ...o,
        }) as ProjectionDataPoint,
    );

  test("stays silent with fewer than three historical points", () => {
    for (const n of [0, 1, 2]) {
      expect(
        generateProjectionAlerts(
          series(n, () => ({})),
          projected([{ totalCost: 1e9 }]),
          1e6,
        ),
      ).toEqual([]);
    }
  });

  test("stays silent when nothing was projected", () => {
    expect(
      generateProjectionAlerts(
        series(5, () => ({})),
        [],
        1e9,
      ),
    ).toEqual([]);
  });

  test("raises danger above the 50% cost-increase threshold", () => {
    const alerts = generateProjectionAlerts(
      series(5, () => ({ totalCost: 100 })),
      projected([{ totalCost: 200 }]),
      1e9,
    );
    expect(alerts.some((a) => a.type === "danger" && a.title === "High Cost Projection")).toBe(
      true,
    );
  });

  test("raises only a warning between the 25% and 50% thresholds", () => {
    const alerts = generateProjectionAlerts(
      series(5, () => ({ totalCost: 100 })),
      projected([{ totalCost: 130 }]),
      1e9,
    );
    expect(alerts.some((a) => a.title === "Moderate Cost Increase")).toBe(true);
    expect(alerts.some((a) => a.title === "High Cost Projection")).toBe(false);
  });

  test("stays quiet on cost below the 25% threshold", () => {
    const alerts = generateProjectionAlerts(
      series(5, () => ({ totalCost: 100 })),
      projected([{ totalCost: 110 }]),
      1e9,
    );
    expect(alerts.some((a) => a.title === "Moderate Cost Increase")).toBe(false);
    expect(alerts.some((a) => a.title === "High Cost Projection")).toBe(false);
  });

  test("a zero-cost baseline produces no Infinity or NaN in alert copy", () => {
    const alerts = generateProjectionAlerts(
      series(5, () => ({ totalCost: 0, totalRequests: 0 })),
      projected([{ totalCost: 5000, totalRequests: 5000 }]),
      1e9,
    );
    for (const alert of alerts) {
      expect(alert.message).not.toContain("Infinity");
      expect(alert.message).not.toContain("NaN");
    }
  });

  test("flags a low balance and reports whole days remaining", () => {
    const alerts = generateProjectionAlerts(
      series(5, () => ({ totalCost: 100 })),
      projected([{ totalCost: 100 }]),
      250,
    );
    const low = alerts.find((a) => a.title === "Low Balance");
    expect(low?.type).toBe("danger");
    expect(low?.message).toContain("2 days");
  });

  test("does not flag a balance covering a week or more", () => {
    const alerts = generateProjectionAlerts(
      series(5, () => ({ totalCost: 100 })),
      projected([{ totalCost: 100 }]),
      700,
    );
    expect(alerts.some((a) => a.title === "Low Balance")).toBe(false);
  });

  test("reports a declining trend as info, not as an increase", () => {
    const alerts = generateProjectionAlerts(
      series(6, (i) => ({ totalCost: 5000 - i * 500 })),
      projected([{ totalCost: 100 }]),
      1e9,
    );
    const info = alerts.find((a) => a.title === "Declining Usage Trend");
    expect(info?.type).toBe("info");
  });
});
