/** Exercises durable multipart Telegram semantics against an owner-fenced in-memory ledger. */

import { describe, expect, test } from "bun:test";
import {
  executeTelegramDelivery,
  type TelegramDeliveryLedger,
  type TelegramDeliveryProgress,
} from "../src/telegram-delivery";

function memoryLedger(initial: TelegramDeliveryProgress | null = null) {
  const state: {
    progress: TelegramDeliveryProgress | null;
    owner: string | null;
  } = {
    progress: initial,
    owner: null,
  };
  const owns = (owner: string): void => {
    if (state.owner !== owner) throw new Error("claim lost");
  };
  const ledger: TelegramDeliveryLedger = {
    async read() {
      return state.progress;
    },
    async claimProcessing(owner) {
      if (state.owner) return false;
      state.owner = owner;
      return true;
    },
    async renewProcessing(owner) {
      return state.owner === owner;
    },
    async releaseProcessing(owner) {
      if (state.owner === owner) state.owner = null;
    },
    async preparePlan(owner, plan) {
      owns(owner);
      state.progress ??= {
        state: "pending",
        ...plan,
        nextChunkIndex: 0,
        providerMessageIds: [],
      };
      return state.progress;
    },
    async claimChunk(owner, chunkIndex) {
      owns(owner);
      if (
        state.progress?.state !== "pending" ||
        state.progress.nextChunkIndex !== chunkIndex
      )
        return false;
      state.progress = {
        ...state.progress,
        state: "egress_started",
        activeChunkIndex: chunkIndex,
      };
      return true;
    },
    async recordAccepted(owner, chunkIndex, providerMessageId) {
      owns(owner);
      if (!state.progress || state.progress.activeChunkIndex !== chunkIndex)
        throw new Error("bad cursor");
      const next = {
        ...state.progress,
        state: "pending" as const,
        nextChunkIndex: chunkIndex + 1,
        providerMessageIds: [
          ...state.progress.providerMessageIds,
          providerMessageId,
        ],
      };
      delete next.activeChunkIndex;
      state.progress = next;
    },
    async recordExplicitRejection(owner, chunkIndex) {
      owns(owner);
      if (!state.progress || state.progress.activeChunkIndex !== chunkIndex)
        throw new Error("bad cursor");
      const next = { ...state.progress, state: "pending" as const };
      delete next.activeChunkIndex;
      state.progress = next;
    },
    async markDelivered(owner) {
      owns(owner);
      if (
        !state.progress ||
        state.progress.nextChunkIndex !== state.progress.totalChunks
      )
        throw new Error("incomplete");
      state.progress = { ...state.progress, state: "delivered" };
    },
  };
  return { ledger, state };
}

const plan = { contentDigest: "a".repeat(64), chunks: ["one", "two"] };

describe("executeTelegramDelivery", () => {
  test("persists each provider receipt and completes a multipart plan", async () => {
    const memory = memoryLedger();
    const outcome = await executeTelegramDelivery(
      memory.ledger,
      async (dispatch) => {
        await dispatch(plan, async (_chunk, index) => ({
          acceptance: "accepted",
          providerMessageId: `m${index}`,
        }));
      },
    );
    expect(outcome).toEqual({
      status: "delivered",
      providerMessageIds: ["m0", "m1"],
    });
    expect(memory.state.progress).toMatchObject({
      state: "delivered",
      nextChunkIndex: 2,
      providerMessageIds: ["m0", "m1"],
    });
  });

  test("keeps the active chunk tombstone when acceptance is unknown", async () => {
    const memory = memoryLedger();
    expect(
      await executeTelegramDelivery(memory.ledger, async (dispatch) => {
        await dispatch(plan, async () => ({ acceptance: "unknown" }));
      }),
    ).toEqual({ status: "uncertain", chunkIndex: 0 });
    expect(memory.state.progress).toMatchObject({
      state: "egress_started",
      activeChunkIndex: 0,
      nextChunkIndex: 0,
    });
    expect(
      (await executeTelegramDelivery(memory.ledger, async () => undefined))
        .status,
    ).toBe("uncertain");
  });

  test("explicit rejection clears the tombstone and permits a safe retry", async () => {
    const memory = memoryLedger();
    const rejected = await executeTelegramDelivery(
      memory.ledger,
      async (dispatch) => {
        await dispatch(plan, async () => ({
          acceptance: "not_accepted",
          errorCode: 429,
          retryAfterSeconds: 7,
        }));
      },
    );
    expect(rejected).toEqual({
      status: "explicitly_rejected",
      chunkIndex: 0,
      errorCode: 429,
      retryAfterSeconds: 7,
    });
    expect(memory.state.progress).toMatchObject({
      state: "pending",
      nextChunkIndex: 0,
    });
    const retried: number[] = [];
    const delivered = await executeTelegramDelivery(
      memory.ledger,
      async (dispatch) => {
        await dispatch(plan, async (_chunk, index) => {
          retried.push(index);
          return { acceptance: "accepted", providerMessageId: `r${index}` };
        });
      },
    );
    expect(retried).toEqual([0, 1]);
    expect(delivered.status).toBe("delivered");
  });

  test("resumes at the persisted cursor without replaying accepted chunks", async () => {
    const memory = memoryLedger({
      state: "pending",
      contentDigest: plan.contentDigest,
      totalChunks: 2,
      nextChunkIndex: 1,
      providerMessageIds: ["m0"],
    });
    const sent: number[] = [];
    await executeTelegramDelivery(memory.ledger, async (dispatch) =>
      dispatch(plan, async (_chunk, index) => {
        sent.push(index);
        return { acceptance: "accepted", providerMessageId: "m1" };
      }),
    );
    expect(sent).toEqual([1]);
    expect(memory.state.progress?.providerMessageIds).toEqual(["m0", "m1"]);
  });

  test("owner-checked release cannot erase a successor claim", async () => {
    const memory = memoryLedger();
    await memory.ledger.claimProcessing("owner-a", 1_000);
    memory.state.owner = "owner-b";
    await memory.ledger.releaseProcessing("owner-a");
    expect(memory.state.owner).toBe("owner-b");
  });
});
