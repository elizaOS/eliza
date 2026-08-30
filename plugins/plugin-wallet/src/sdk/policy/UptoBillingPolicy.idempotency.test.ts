import { describe, expect, it } from "vitest";
import { UptoBillingPolicy } from "./UptoBillingPolicy.js";

function createAuthorization(
  policy: UptoBillingPolicy,
  authorizationId = "auth-1",
) {
  return policy.authorize({
    authorizationId,
    service: "example-service",
    network: "base",
    asset: "USDC",
    payTo: "0x1111111111111111111111111111111111111111",
    maxAmount: 1_000n,
  });
}

describe("UptoBillingPolicy settlement idempotency", () => {
  it("does not book a retried txHash twice", () => {
    const policy = new UptoBillingPolicy();
    createAuthorization(policy);

    const first = policy.recordSettlement("auth-1", 250n, {
      txHash: "0xsettlement",
    });
    const replay = policy.recordSettlement("auth-1", 250n, {
      txHash: "0xsettlement",
    });

    expect(first.authorization.settledAmount).toBe(250n);
    expect(replay.authorization.settledAmount).toBe(250n);
    expect(replay.authorization.remainingAmount).toBe(750n);
    expect(replay.settlements).toHaveLength(1);
    expect(
      replay.ledgerDeltas.filter((delta) => delta.type === "settlement"),
    ).toHaveLength(1);
    expect(policy.getNetWalletDelta("auth-1")).toBe(-250n);
  });

  it("rejects a conflicting amount for an existing txHash", () => {
    const policy = new UptoBillingPolicy();
    createAuthorization(policy);

    policy.recordSettlement("auth-1", 250n, { txHash: "0xsettlement" });

    expect(() =>
      policy.recordSettlement("auth-1", 300n, { txHash: "0xsettlement" }),
    ).toThrow(/conflicting amount/);
    expect(policy.getAuthorization("auth-1")?.settledAmount).toBe(250n);
  });

  it("accepts an exact replay after the authorization was finalized", () => {
    const policy = new UptoBillingPolicy();
    createAuthorization(policy);

    policy.recordSettlement("auth-1", 250n, {
      txHash: "0xsettlement",
      finalize: true,
    });

    const replay = policy.recordSettlement("auth-1", 250n, {
      txHash: "0xsettlement",
    });

    expect(replay.authorization.status).toBe("settled");
    expect(replay.authorization.settledAmount).toBe(250n);
    expect(replay.authorization.releasedAmount).toBe(750n);
    expect(replay.settlements).toHaveLength(1);
  });

  it("honors finalize when a replay adds the terminal effect", () => {
    const policy = new UptoBillingPolicy();
    createAuthorization(policy);

    const first = policy.recordSettlement("auth-1", 250n, {
      txHash: "0xsettlement",
      settledAt: "2026-08-30T10:00:00.000Z",
      reference: "usage-42",
    });
    expect(first.authorization.status).toBe("partially_settled");

    const replay = policy.recordSettlement("auth-1", 250n, {
      txHash: "0xsettlement",
      finalize: true,
    });

    expect(replay.authorization.status).toBe("settled");
    expect(replay.authorization.remainingAmount).toBe(0n);
    expect(replay.authorization.releasedAmount).toBe(750n);
    expect(replay.authorization.finalizedAt).toBe("2026-08-30T10:00:00.000Z");
    expect(replay.settlements).toHaveLength(1);
    expect(
      replay.ledgerDeltas.filter((delta) => delta.type === "settlement"),
    ).toHaveLength(1);
    expect(
      replay.ledgerDeltas.filter((delta) => delta.type === "release"),
    ).toHaveLength(1);
    expect(policy.getNetWalletDelta("auth-1")).toBe(-250n);
  });

  it("scopes a txHash replay key to one authorization", () => {
    const policy = new UptoBillingPolicy();
    createAuthorization(policy, "auth-1");
    createAuthorization(policy, "auth-2");

    policy.recordSettlement("auth-1", 250n, { txHash: "0xbatched" });
    policy.recordSettlement("auth-2", 400n, { txHash: "0xbatched" });

    expect(policy.getAuthorization("auth-1")?.settledAmount).toBe(250n);
    expect(policy.getAuthorization("auth-2")?.settledAmount).toBe(400n);
    expect(policy.getSettlements("auth-1")).toHaveLength(1);
    expect(policy.getSettlements("auth-2")).toHaveLength(1);
  });

  it("keeps settlements without a txHash additive", () => {
    const policy = new UptoBillingPolicy();
    createAuthorization(policy);

    policy.recordSettlement("auth-1", 250n);
    const second = policy.recordSettlement("auth-1", 250n);

    expect(second.authorization.settledAmount).toBe(500n);
    expect(second.authorization.remainingAmount).toBe(500n);
    expect(second.settlements).toHaveLength(2);
    expect(
      second.ledgerDeltas.filter((delta) => delta.type === "settlement"),
    ).toHaveLength(2);
    expect(policy.getNetWalletDelta("auth-1")).toBe(-500n);
  });
});
