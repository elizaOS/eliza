import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemorySafe, isDuplicateTweet, isTweetProcessed } from "./memory";

function runtimeWithStorage(overrides: Partial<IAgentRuntime>): IAgentRuntime {
  return {
    agentId: "agent-1",
    ...overrides,
  } as IAgentRuntime;
}

describe("Twitter memory utilities", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats duplicate memory writes as idempotent without retrying", async () => {
    const createMemory = vi.fn(async () => {
      throw new Error("duplicate key constraint failed");
    });
    const runtime = runtimeWithStorage({ createMemory });

    await expect(
      createMemorySafe(runtime, { id: "memory-1" } as Memory, "messages", 3),
    ).resolves.toBeUndefined();

    expect(createMemory).toHaveBeenCalledTimes(1);
  });

  it("retries transient memory write failures and then succeeds", async () => {
    const createMemory = vi
      .fn()
      .mockRejectedValueOnce(new Error("database is busy"))
      .mockResolvedValueOnce(undefined);
    const runtime = runtimeWithStorage({ createMemory });

    const write = createMemorySafe(
      runtime,
      { id: "memory-1" } as Memory,
      "messages",
      2,
    );
    await vi.advanceTimersByTimeAsync(1000);

    await expect(write).resolves.toBeUndefined();
    expect(createMemory).toHaveBeenCalledTimes(2);
  });

  it("falls back to unprocessed when tweet lookup storage fails", async () => {
    const runtime = runtimeWithStorage({
      getMemoryById: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    });

    await expect(isTweetProcessed(runtime, "tweet-1")).resolves.toBe(false);
  });

  it("detects duplicate tweets after trimming case and punctuation-like spacing", async () => {
    const runtime = runtimeWithStorage({
      getCache: vi.fn(async () => ["  Launch update  ", "short"]),
    });

    await expect(
      isDuplicateTweet(runtime, "bot", "launch update"),
    ).resolves.toBe(true);
    await expect(isDuplicateTweet(runtime, "bot", "short note")).resolves.toBe(
      true,
    );
    await expect(isDuplicateTweet(runtime, "bot", "fresh idea")).resolves.toBe(
      false,
    );
  });

  it("uses token similarity for reordered near-duplicate tweets", async () => {
    const runtime = runtimeWithStorage({
      getCache: vi.fn(async () => [
        "Launch update: we shipped the new wallet dashboard today.",
      ]),
    });

    await expect(
      isDuplicateTweet(
        runtime,
        "bot",
        "We shipped the new wallet dashboard today — launch update!",
      ),
    ).resolves.toBe(true);
  });

  it("honors the duplicate similarity threshold", async () => {
    const runtime = runtimeWithStorage({
      getCache: vi.fn(async () => ["Launch update: wallet dashboard shipped"]),
    });

    await expect(
      isDuplicateTweet(runtime, "bot", "Dashboard shipped wallet", 0.8),
    ).resolves.toBe(false);
    await expect(
      isDuplicateTweet(runtime, "bot", "Dashboard shipped wallet", 0.6),
    ).resolves.toBe(true);
  });
});
