/** Exercises the exact-once Telegram delivery state machine against a real in-memory ledger. */

import { describe, expect, test } from "bun:test";
import {
  executeTelegramDelivery,
  type TelegramDeliveryLedger,
  type TelegramDeliveryState,
  TelegramEgressAlreadyClaimedError,
} from "../src/telegram-delivery";

function memoryLedger(initial: TelegramDeliveryState | null = null): {
  ledger: TelegramDeliveryLedger;
  state: { delivery: TelegramDeliveryState | null; processing: boolean };
} {
  const state = { delivery: initial, processing: false };
  return {
    state,
    ledger: {
      async read() {
        return state.delivery;
      },
      async claimProcessing() {
        if (state.processing) return false;
        state.processing = true;
        return true;
      },
      async releaseProcessing() {
        state.processing = false;
      },
      async claimEgress() {
        if (state.delivery) return false;
        state.delivery = "egress_started";
        return true;
      },
      async markDelivered() {
        state.delivery = "delivered";
      },
    },
  };
}

describe("executeTelegramDelivery", () => {
  test("marks a successful send delivered after the pre-egress barrier", async () => {
    const memory = memoryLedger();
    let barrierObserved = false;
    const outcome = await executeTelegramDelivery(
      memory.ledger,
      async (beforeEgress) => {
        await beforeEgress();
        barrierObserved = memory.state.delivery === "egress_started";
      },
    );

    expect(outcome).toBe("delivered");
    expect(barrierObserved).toBe(true);
    expect(memory.state.delivery).toBe("delivered");
  });

  test("releases processing when generation fails before egress", async () => {
    const memory = memoryLedger();
    await expect(
      executeTelegramDelivery(memory.ledger, async () => {
        throw new Error("model unavailable");
      }),
    ).rejects.toThrow("model unavailable");
    expect(memory.state.processing).toBe(false);
    expect(memory.state.delivery).toBeNull();
  });

  test("keeps the irreversible tombstone after an ambiguous provider send", async () => {
    const memory = memoryLedger();
    await expect(
      executeTelegramDelivery(memory.ledger, async (beforeEgress) => {
        await beforeEgress();
        throw new Error("provider response lost");
      }),
    ).rejects.toThrow("provider response lost");
    expect(memory.state.delivery).toBe("egress_started");
    expect(
      await executeTelegramDelivery(memory.ledger, async () => undefined),
    ).toBe("uncertain");
  });

  test("reports duplicates and concurrent processing without running delivery", async () => {
    const duplicate = memoryLedger("delivered");
    let calls = 0;
    expect(
      await executeTelegramDelivery(duplicate.ledger, async () => {
        calls += 1;
      }),
    ).toBe("duplicate");
    const concurrent = memoryLedger();
    concurrent.state.processing = true;
    expect(
      await executeTelegramDelivery(concurrent.ledger, async () => {
        calls += 1;
      }),
    ).toBe("in_progress");
    expect(calls).toBe(0);
  });

  test("surfaces an egress claim lost after processing ownership", async () => {
    const memory = memoryLedger();
    memory.ledger.claimEgress = async () => false;
    await expect(
      executeTelegramDelivery(memory.ledger, async (beforeEgress) => {
        await beforeEgress();
      }),
    ).rejects.toBeInstanceOf(TelegramEgressAlreadyClaimedError);
    expect(memory.state.processing).toBe(false);
  });
});
