/**
 * Tests for resolveBillableCost — the proxy engine's billing decision.
 *
 * Regression: a no-upstream fast-fail 5xx response (for example a circuit-open
 * 503) used to reconcile the full reserved `cost`, over-billing the org for a
 * request that returned no service. Provider-attempted 5xx responses may still
 * represent real upstream spend, so handlers must report actualCost: 0 when no
 * upstream work happened.
 */

import { describe, expect, test } from "bun:test";
import { resolveBillableCost } from "./engine";

function res(status: number): { ok: boolean; status: number } {
  return { ok: status >= 200 && status < 300, status };
}

const RESERVED = 100;

describe("resolveBillableCost", () => {
  test("2xx success without actualCost bills the full reserved cost", () => {
    expect(resolveBillableCost({ response: res(200) }, RESERVED)).toBe(RESERVED);
  });

  test("2xx success with a reported actualCost bills that amount", () => {
    expect(resolveBillableCost({ response: res(200), actualCost: 42 }, RESERVED)).toBe(42);
  });

  test("3xx (response.ok false but <500) bills the reserved cost", () => {
    // A 3xx is not a server error; preserve prior full-charge behavior.
    expect(resolveBillableCost({ response: res(302) }, RESERVED)).toBe(RESERVED);
  });

  test("5xx without actualCost preserves reserved cost for provider-attempted failures", () => {
    expect(resolveBillableCost({ response: res(502) }, RESERVED)).toBe(RESERVED);
  });

  test("503 circuit-open with explicit zero actualCost refunds to 0", () => {
    expect(resolveBillableCost({ response: res(503), actualCost: 0 }, RESERVED)).toBe(0);
  });

  test("500 with an explicit partial actualCost bills only that partial cost", () => {
    expect(resolveBillableCost({ response: res(500), actualCost: 5 }, RESERVED)).toBe(5);
  });

  test("4xx client error still bills the reserved cost", () => {
    // 4xx is treated as a client error; prior behavior is preserved.
    expect(resolveBillableCost({ response: res(400) }, RESERVED)).toBe(RESERVED);
  });

  test("4xx with a reported actualCost bills that amount", () => {
    expect(resolveBillableCost({ response: res(429), actualCost: 0 }, RESERVED)).toBe(0);
  });
});
