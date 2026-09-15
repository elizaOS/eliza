/** Verifies every machine-readable pairing failure has a distinct user action. */

import { describe, expect, it } from "vitest";
import {
  type PairingFailureCode,
  pairingFailureMessage,
} from "./usePairingState";

describe("pairingFailureMessage", () => {
  const cases: Array<[PairingFailureCode, RegExp]> = [
    ["PAIRING_INVALID", /invalid/i],
    ["PAIRING_EXPIRED", /expired/i],
    ["PAIRING_DISABLED", /disabled/i],
    ["PAIRING_NOT_READY", /still starting/i],
    ["PAIRING_INSTANCE_MISMATCH", /instance changed/i],
    ["PAIRING_RATE_LIMITED", /too many attempts/i],
    ["PAIRING_SESSION_FAILED", /could not create a session/i],
  ];

  it.each(cases)("renders %s as an actionable state", (code, expected) => {
    expect(pairingFailureMessage({ code })).toMatch(expected);
  });

  it("retains status compatibility for older servers", () => {
    expect(pairingFailureMessage({ status: 410 })).toMatch(/expired/i);
    expect(pairingFailureMessage({ status: 429 })).toMatch(/too many/i);
    expect(pairingFailureMessage({ status: 500 })).toMatch(/failed/i);
  });
});
