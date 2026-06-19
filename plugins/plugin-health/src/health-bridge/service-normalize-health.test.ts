import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  LIFEOPS_HEALTH_SIGNAL_SOURCES,
  type LifeOpsHealthSignal,
} from "../contracts/health.js";
import { normalizeHealthSignal } from "./service-normalize-health.js";

function expectCanonicalHealthSignal(value: LifeOpsHealthSignal): void {
  expect(LIFEOPS_HEALTH_SIGNAL_SOURCES).toContain(value.source);
  expect(typeof value.permissions.sleep).toBe("boolean");
  expect(typeof value.permissions.biometrics).toBe("boolean");
  expect(typeof value.sleep.available).toBe("boolean");
  expect(typeof value.sleep.isSleeping).toBe("boolean");
  expect(
    value.sleep.asleepAt === null || Date.parse(value.sleep.asleepAt),
  ).not.toBeNaN();
  expect(
    value.sleep.awakeAt === null || Date.parse(value.sleep.awakeAt),
  ).not.toBeNaN();
  expect(
    value.sleep.durationMinutes === null ||
      Number.isFinite(value.sleep.durationMinutes),
  ).toBe(true);
  expect(
    value.sleep.stage === null || typeof value.sleep.stage === "string",
  ).toBe(true);
  expect(
    value.biometrics.sampleAt === null || Date.parse(value.biometrics.sampleAt),
  ).not.toBeNaN();
  for (const metric of [
    value.biometrics.heartRateBpm,
    value.biometrics.restingHeartRateBpm,
    value.biometrics.heartRateVariabilityMs,
    value.biometrics.respiratoryRate,
    value.biometrics.bloodOxygenPercent,
  ]) {
    expect(metric === null || Number.isFinite(metric)).toBe(true);
  }
  expect(value.warnings.every((warning) => typeof warning === "string")).toBe(
    true,
  );
}

describe("normalizeHealthSignal", () => {
  it("defaults missing and null nested records to a conservative signal", () => {
    expect(normalizeHealthSignal({}, "health")).toEqual({
      source: "healthkit",
      permissions: { sleep: false, biometrics: false },
      sleep: {
        available: false,
        isSleeping: false,
        asleepAt: null,
        awakeAt: null,
        durationMinutes: null,
        stage: null,
      },
      biometrics: {
        sampleAt: null,
        heartRateBpm: null,
        restingHeartRateBpm: null,
        heartRateVariabilityMs: null,
        respiratoryRate: null,
        bloodOxygenPercent: null,
      },
      warnings: [],
    });

    expect(
      normalizeHealthSignal(
        { sleep: null, biometrics: null, permissions: null },
        "health",
      ),
    ).toEqual(normalizeHealthSignal({}, "health"));
  });

  it("coerces optional booleans and finite numeric strings without accepting junk", () => {
    const signal = normalizeHealthSignal(
      {
        source: "oura",
        permissions: { sleep: "true", biometrics: 1 },
        sleep: {
          available: "false",
          isSleeping: 0,
          asleepAt: "2026-05-30T06:00:00.000Z",
          awakeAt: "2026-05-30T13:30:00.000Z",
          durationMinutes: "450",
          stage: "deep",
        },
        biometrics: {
          sampleAt: "2026-05-30T13:30:00.000Z",
          heartRateBpm: "61.5",
        },
        warnings: [" stale token "],
      },
      "health",
    );

    expect(signal?.source).toBe("oura");
    expect(signal?.permissions).toEqual({ sleep: true, biometrics: true });
    expect(signal?.sleep.available).toBe(false);
    expect(signal?.sleep.isSleeping).toBe(false);
    expect(signal?.sleep.durationMinutes).toBe(450);
    expect(signal?.biometrics.heartRateBpm).toBe(61.5);
    expect(signal?.warnings).toEqual(["stale token"]);
  });

  it.each([
    [{ source: "bogus" }, "health.source"],
    [{ sleep: [] }, "health.sleep"],
    [{ sleep: { asleepAt: "not a date" } }, "health.sleep.asleepAt"],
    [{ biometrics: { heartRateBpm: "nan" } }, "health.biometrics.heartRateBpm"],
    [{ warnings: ["ok", ""] }, "health.warnings[1]"],
  ])("rejects malformed payload at %s", (payload, field) => {
    expect(() => normalizeHealthSignal(payload, "health")).toThrow(
      expect.objectContaining({
        status: 400,
        message: expect.stringContaining(field),
      }),
    );
  });

  it("fuzzes arbitrary JSON into either a canonical signal or a 400 normalization error", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (payload) => {
        try {
          const normalized = normalizeHealthSignal(payload, "health");
          if (normalized !== null) expectCanonicalHealthSignal(normalized);
        } catch (error) {
          expect(error).toMatchObject({ status: 400 });
        }
      }),
      { numRuns: 300 },
    );
  });
});
