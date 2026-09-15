/**
 * Unit tests for spend-allowance: validates decideSpendAuthorization logic.
 */
import { describe, expect, it } from "vitest";
import {
  decideSpendAuthorization,
  stripSpendHints,
} from "./spend-allowance.ts";

describe("spend-allowance", () => {
  it("auto-authorizes non-mutating read and dry-run commands", () => {
    const dec = decideSpendAuthorization({
      command: "status.get",
      risk: "read",
      capUsd: 0,
      alreadySpentUsd: 0,
    });
    expect(dec.autoAuthorize).toBe(true);
    expect(dec.reason).toBe("non-mutating");
  });

  it("rejects mutating commands when spend cap is zero / disabled", () => {
    const dec = decideSpendAuthorization({
      command: "containers.create",
      risk: "paid",
      capUsd: 0,
      alreadySpentUsd: 0,
    });
    expect(dec.autoAuthorize).toBe(false);
    expect(dec.reason).toBe("allowance-disabled");
  });

  it("requires human confirmation for destructive risk regardless of cap", () => {
    const dec = decideSpendAuthorization({
      command: "containers.delete",
      risk: "destructive",
      capUsd: 100,
      alreadySpentUsd: 0,
    });
    expect(dec.autoAuthorize).toBe(false);
    expect(dec.reason).toBe("destructive-requires-human");
  });

  it("strips spend hint parameters from request parameters", () => {
    const params = { spendEstimateUsd: 5.0, name: "my-app" };
    const clean = stripSpendHints(params);
    expect(clean).toEqual({ name: "my-app" });
  });
});
