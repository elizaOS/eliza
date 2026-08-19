/**
 * Deterministic coverage for scenario-report redaction: sensitive keys, cycle
 * and depth fail-closed, and the visit budget so a hostile payload cannot
 * blow the stack while persisting the aggregate report.
 */
import { describe, expect, it } from "vitest";
import {
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
    const redacted = redactForScenarioReport(cyclic) as Record<string, unknown>;
    expect(redacted.token).toBe("[REDACTED]");
    expect(redacted.ok).toBe(1);
    expect(redacted.self).toBe("[REDACTED]");
  });

  it("preserves and redacts a 20k-deep nest without overflowing the stack", () => {
    const redacted = redactForScenarioReport(
      nest(20_000, { token: "s3cret", ok: 1 }),
    ) as Record<string, unknown>;
    let cursor: unknown = redacted;
    for (let i = 0; i < 20_000; i += 1) {
      expect(cursor).toEqual(
        expect.objectContaining({ wrap: expect.anything() }),
      );
      cursor = (cursor as { wrap: unknown }).wrap;
    }
    expect(cursor).toEqual({ token: "[REDACTED]", ok: 1 });
  });

  it("preserves a wide report instead of silently truncating evidence", () => {
    const redacted = redactForScenarioReport({
      items: Array.from({ length: 10_000 }, (_, index) => ({
        index,
        token: `secret-${index}`,
      })),
    }) as { items: unknown[] };
    expect(redacted.items).toHaveLength(10_000);
    expect(redacted.items.at(-1)).toEqual({
      index: 9_999,
      token: "[REDACTED]",
    });
  });

  it("redacts only ancestor cycles, not repeated acyclic references", () => {
    const shared = { ok: 1, token: "secret" };
    expect(redactForScenarioReport({ first: shared, second: shared })).toEqual({
      first: { ok: 1, token: "[REDACTED]" },
      second: { ok: 1, token: "[REDACTED]" },
    });
  });

  it("keeps an honest shallow nest", () => {
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
