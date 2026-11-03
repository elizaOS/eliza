import { describe, expect, it } from "bun:test";
import { applyPayment, judgePayment, type CryptoOrder, type ObservedTransfer } from "./crypto-pay.ts";
import type { MemoryStore } from "./worker.ts";

const recipient = "Recv1111111111111111111111111111111111111";
const reference = "Ref11111111111111111111111111111111111111";
const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function order(): CryptoOrder {
  return {
    id: "order-1",
    userId: "user-1",
    emailHash: "abc",
    plan: "monthly",
    asset: "usdc",
    amountBase: "9990000",
    mint: usdc,
    reference,
    recipient,
    createdAt: 1,
    expiresAt: 10_000,
    status: "open",
  };
}

function transfer(patch: Partial<ObservedTransfer> = {}): ObservedTransfer {
  return {
    signature: "sig-1",
    commitment: "confirmed",
    recipient,
    amountBase: "9990000",
    mint: usdc,
    references: [reference],
    ...patch,
  };
}

function store(): MemoryStore {
  return { keys: new Map(), usage: new Map() };
}

describe("crypto transfer checks", () => {
  it("rejects the wrong amount, mint, recipient, and a replayed signature", () => {
    const now = 1_000;
    const row = order();
    expect(judgePayment(row, transfer({ amountBase: "100" }), new Set(), now)).toBe("wrong-amount");
    expect(judgePayment(row, transfer({ mint: "SOL" }), new Set(), now)).toBe("wrong-mint");
    expect(judgePayment(row, transfer({ recipient: "Other111111111111111111111111111111111111" }), new Set(), now)).toBe("wrong-recipient");
    expect(judgePayment(row, transfer({ commitment: "processed" }), new Set(), now)).toBe("unconfirmed");
    const box = store();
    const first = applyPayment(box, row, transfer(), now);
    expect(first.judge).toBe("ok");
    expect(first.until).toBe(now + 30 * 24 * 60 * 60 * 1000);
    const again = applyPayment(box, order(), transfer(), now);
    expect(again.judge).toBe("replay");
    expect(again.until).toBeNull();
  });
});
