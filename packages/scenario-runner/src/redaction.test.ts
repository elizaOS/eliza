/**
 * Deterministic coverage for scenario-report redaction: sensitive keys, cycle
 * and depth fail-closed, and the visit budget so a hostile payload cannot
 * blow the stack while persisting the aggregate report.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_SCENARIO_REDACT_DEPTH,
  MAX_SCENARIO_REDACT_VISIT,
  redactedSensitiveActionResult,
  redactForScenarioReport,
} from "./redaction.ts";

function nest(depth: number, leaf: Record<string, unknown>): unknown {
  let current: unknown = leaf;
  for (let i = 0; i < depth; i += 1) {
    current = { wrap: current };
  }
  return current;
}

describe("redactForScenarioReport", () => {
  it("masks sensitive keys and leaves the rest", () => {
    expect(
      redactForScenarioReport({
        token: "s3cret",
        nested: { api_key: "k", ok: 1 },
      }),
    ).toEqual({
      token: "[REDACTED]",
      nested: { api_key: "[REDACTED]", ok: 1 },
    });
  });

  it("honors explicit field paths", () => {
    expect(
      redactForScenarioReport({ keep: "visible", hide: "nope" }, ["hide"]),
    ).toEqual({ keep: "visible", hide: "[REDACTED]" });
  });

  it("fails closed on a cyclic report object without overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { token: "s3cret", ok: 1 };
    cyclic.self = cyclic;
    const started = performance.now();
    const redacted = redactForScenarioReport(cyclic) as Record<string, unknown>;
    expect(performance.now() - started).toBeLessThan(50);
    expect(redacted.token).toBe("[REDACTED]");
    expect(redacted.ok).toBe(1);
    expect(redacted.self).toBe("[REDACTED]");
  });

  it("fails closed on a hostile 20k-deep nest in under 50ms", () => {
    const started = performance.now();
    const redacted = redactForScenarioReport(
      nest(20_000, { token: "s3cret", ok: 1 }),
    ) as Record<string, unknown>;
    expect(performance.now() - started).toBeLessThan(50);
    let cursor: unknown = redacted;
    for (let i = 0; i < MAX_SCENARIO_REDACT_DEPTH; i += 1) {
      expect(cursor).toEqual(
        expect.objectContaining({ wrap: expect.anything() }),
      );
      cursor = (cursor as { wrap: unknown }).wrap;
    }
    expect(cursor).toBe("[REDACTED]");
  });

  it("stops a wide array at the visit budget instead of walking every slot", () => {
    const started = performance.now();
    const redacted = redactForScenarioReport({
      items: Array.from({ length: MAX_SCENARIO_REDACT_VISIT + 100 }, () => ({
        ok: 1,
      })),
    }) as { items: unknown[] };
    expect(performance.now() - started).toBeLessThan(50);
    expect(redacted.items.length).toBeLessThanOrEqual(
      MAX_SCENARIO_REDACT_VISIT + 1,
    );
    expect(redacted.items.includes("[REDACTED]")).toBe(true);
  });

  it(`keeps an honest nest shallower than ${MAX_SCENARIO_REDACT_DEPTH}`, () => {
    expect(redactForScenarioReport(nest(4, { ok: true, token: "x" }))).toEqual(
      nest(4, { ok: true, token: "[REDACTED]" }),
    );
  });
});

describe("redactedSensitiveActionResult", () => {
  it("returns the placeholder result", () => {
    expect(redactedSensitiveActionResult("SEND_EMAIL")).toEqual({
      actionName: "SEND_EMAIL",
      suppressed: true,
      reason: "sensitive_action_result",
    });
  });
});
