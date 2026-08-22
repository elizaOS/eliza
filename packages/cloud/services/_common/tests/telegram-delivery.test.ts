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
  state: {
    delivery: TelegramDeliveryState | null;
    processing: boolean;
    plan: string[] | null;
    chunks: Map<number, TelegramDeliveryState>;
    providerMessageIds: Map<number, string>;
  };
} {
  const state = {
    delivery: initial,
    processing: false,
    plan: null as string[] | null,
    chunks: new Map<number, TelegramDeliveryState>(),
    providerMessageIds: new Map<number, string>(),
  };
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
      async preparePlan(digests) {
        if (!state.plan) {
          state.plan = [...digests];
          return "prepared";
        }
        return state.plan.join(":") === digests.join(":")
          ? "prepared"
          : "conflict";
      },
      async readChunk(index) {
        return state.chunks.get(index) ?? null;
      },
      async readChunkProviderMessageId(index) {
        return state.providerMessageIds.get(index) ?? null;
      },
      async claimChunk(index) {
        if (state.chunks.has(index)) return false;
        state.chunks.set(index, "uncertain");
        return true;
      },
      async releaseChunk(index) {
        state.chunks.delete(index);
      },
      async markChunkDelivered(index, _digest, providerMessageId) {
        state.chunks.set(index, "delivered");
        if (providerMessageId) {
          state.providerMessageIds.set(index, providerMessageId);
        }
      },
      async markDelivered() {
        state.delivery = "delivered";
      },
    },
  };
}

describe("executeTelegramDelivery", () => {
  test("marks a successful chunk delivered after its egress claim", async () => {
    const memory = memoryLedger();
    let claimObserved = false;
    const outcome = await executeTelegramDelivery(
      memory.ledger,
      async (hooks) => {
        await hooks.prepare(["reply"]);
        expect(await hooks.shouldSend(0, "reply")).toBe(true);
        claimObserved = memory.state.chunks.get(0) === "uncertain";
        await hooks.accepted(0, "reply", "provider-1");
      },
    );

    expect(outcome).toBe("delivered");
    expect(claimObserved).toBe(true);
    expect(memory.state.chunks.get(0)).toBe("delivered");
    expect(memory.state.providerMessageIds.get(0)).toBe("provider-1");
    expect(memory.state.delivery).toBe("delivered");
  });

  test("recovers a provider id for a chunk accepted by an earlier attempt", async () => {
    const memory = memoryLedger();
    memory.state.plan = [
      "5782b18687e6cf8a482fc32d2db5b196d8821c458a0c069c6acf3953446e7bb5",
    ];
    memory.state.chunks.set(0, "delivered");
    memory.state.providerMessageIds.set(0, "provider-prior");

    await executeTelegramDelivery(memory.ledger, async (hooks) => {
      await hooks.prepare(["reply"]);
      expect(await hooks.shouldSend(0, "reply")).toBe(false);
      expect(await hooks.deliveredProviderMessageId(0, "reply")).toBe(
        "provider-prior",
      );
    });
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
      executeTelegramDelivery(memory.ledger, async (hooks) => {
        await hooks.prepare(["reply"]);
        await hooks.shouldSend(0, "reply");
        throw new Error("provider response lost");
      }),
    ).rejects.toThrow("provider response lost");
    expect(memory.state.chunks.get(0)).toBe("uncertain");
    expect(
      await executeTelegramDelivery(memory.ledger, async () => undefined),
    ).toBe("in_progress");
    memory.state.processing = false;
    await expect(
      executeTelegramDelivery(memory.ledger, async (hooks) => {
        await hooks.prepare(["reply"]);
        await hooks.shouldSend(0, "reply");
      }),
    ).rejects.toBeInstanceOf(TelegramEgressAlreadyClaimedError);
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
    memory.ledger.claimChunk = async () => false;
    await expect(
      executeTelegramDelivery(memory.ledger, async (hooks) => {
        await hooks.prepare(["reply"]);
        await hooks.shouldSend(0, "reply");
      }),
    ).rejects.toBeInstanceOf(TelegramEgressAlreadyClaimedError);
    expect(memory.state.processing).toBe(false);
  });

  test("never resends after provider acceptance when persistence fails", async () => {
    const memory = memoryLedger();
    memory.ledger.markChunkDelivered = async () => {
      throw new Error("ledger write failed after provider acceptance");
    };
    await expect(
      executeTelegramDelivery(memory.ledger, async (hooks) => {
        await hooks.prepare(["reply"]);
        await hooks.shouldSend(0, "reply");
        await hooks.accepted(0, "reply", "provider-1");
      }),
    ).rejects.toThrow("ledger write failed after provider acceptance");
    expect(memory.state.chunks.get(0)).toBe("uncertain");
    memory.state.processing = false;
    await expect(
      executeTelegramDelivery(memory.ledger, async (hooks) => {
        await hooks.prepare(["reply"]);
        await hooks.shouldSend(0, "reply");
      }),
    ).rejects.toBeInstanceOf(TelegramEgressAlreadyClaimedError);
  });
});
