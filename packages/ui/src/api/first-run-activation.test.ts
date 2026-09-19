/** Tests first-run completion against deterministic activation transport replies. */
import { describe, expect, it } from "vitest";
import { waitForFirstRunActivation } from "./first-run-activation";

const operationId = "58a759fc-1bc5-41d1-a59c-f970ae21e103";
const pending = { operationId, status: "pending", error: null };

describe("first-run activation completion", () => {
  it("retains synchronous embedded-kernel completion", async () => {
    await waitForFirstRunActivation({ ok: true }, async () => {
      throw new Error("Synchronous completion must not poll");
    });
  });

  it("waits for the same accepted operation to succeed", async () => {
    const reads: string[] = [];
    await waitForFirstRunActivation(
      { ok: true, activation: pending },
      async (id) => {
        reads.push(id);
        return {
          ...pending,
          status: reads.length === 1 ? "running" : "succeeded",
        };
      },
    );
    expect(reads).toEqual([operationId, operationId]);
  });

  it("surfaces failed activation instead of completing setup", async () => {
    await expect(
      waitForFirstRunActivation(
        { ok: true, activation: pending },
        async () => ({
          ...pending,
          status: "failed",
          error: "Provider authentication failed. Retry setup.",
        }),
      ),
    ).rejects.toThrow("Provider authentication failed");
  });

  it("rejects another operation's successful receipt", async () => {
    await expect(
      waitForFirstRunActivation(
        { ok: true, activation: pending },
        async () => ({
          ...pending,
          operationId: "d4a1a1c8-eebc-4b9b-92a3-f63557651007",
          status: "succeeded",
        }),
      ),
    ).rejects.toThrow("different operation");
  });

  it("rejects malformed activation receipts", async () => {
    await expect(
      waitForFirstRunActivation(
        { ok: true, activation: pending },
        async () => ({ operationId, status: "succeeded" }),
      ),
    ).rejects.toThrow();
  });

  it("reports a pending operation at the caller's timeout boundary", async () => {
    await expect(
      waitForFirstRunActivation(
        { ok: true, activation: pending },
        async () => pending,
        0,
      ),
    ).rejects.toThrow("still pending");
  });
});
