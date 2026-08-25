import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bot } from "./bot.js";

vi.mock("./delivery-error.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./delivery-error.js")>();
  return {
    ...original,
    hasCommittedWechatSideEffect: vi.fn(() => false),
  };
});

import { hasCommittedWechatSideEffect } from "./delivery-error.js";

const mockedHasSideEffect = vi.mocked(hasCommittedWechatSideEffect);

function textMessage(id: string, group = false) {
  return { id, type: "text", content: "hi", group } as never;
}

describe("wechat inbound Bot gate", () => {
  let onMessage: ReturnType<typeof vi.fn>;
  let bot: Bot;

  beforeEach(() => {
    vi.useFakeTimers();
    onMessage = vi.fn().mockResolvedValue(undefined);
    mockedHasSideEffect.mockReturnValue(false);
    bot = new Bot({ onMessage });
  });

  afterEach(() => {
    bot.stop();
    vi.useRealTimers();
  });

  it("delivers a first-time message", async () => {
    await bot.handleIncoming(textMessage("m1"));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a repeat delivery inside the dedup window", async () => {
    await bot.handleIncoming(textMessage("m1"));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await bot.handleIncoming(textMessage("m1"));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("delivers again after the dedup window expires", async () => {
    await bot.handleIncoming(textMessage("m1"));
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    await bot.handleIncoming(textMessage("m1"));
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("delivers distinct ids independently", async () => {
    await bot.handleIncoming(textMessage("m1"));
    await bot.handleIncoming(textMessage("m2"));
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent deliveries of the same id into one", async () => {
    let resolveFirst: () => void = () => {};
    onMessage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const first = bot.handleIncoming(textMessage("m1"));
    // Let the first delivery reach the in-flight promise before the second.
    await Promise.resolve();
    const second = bot.handleIncoming(textMessage("m1"));
    resolveFirst();
    await Promise.all([first, second]);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("does not dedup a failed delivery without a committed side effect", async () => {
    onMessage.mockRejectedValueOnce(new Error("network"));
    await expect(bot.handleIncoming(textMessage("m1"))).rejects.toThrow(
      "network",
    );
    // A retry must be allowed to deliver again.
    await bot.handleIncoming(textMessage("m1"));
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it("dedups a failed delivery that already committed a side effect", async () => {
    mockedHasSideEffect.mockReturnValue(true);
    onMessage.mockRejectedValueOnce(new Error("post-send crash"));
    await expect(bot.handleIncoming(textMessage("m1"))).rejects.toThrow(
      "post-send crash",
    );
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await bot.handleIncoming(textMessage("m1"));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("feature-gates group messages when disabled", async () => {
    bot.stop();
    bot = new Bot({ onMessage, featuresGroups: false });
    await bot.handleIncoming(textMessage("g1", true));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("feature-gates image messages when disabled", async () => {
    bot.stop();
    bot = new Bot({ onMessage, featuresImages: false });
    await bot.handleIncoming({ id: "i1", type: "image", content: "" } as never);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("skips unknown message types", async () => {
    await bot.handleIncoming({
      id: "u1",
      type: "unknown",
      content: "",
    } as never);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("evicts the oldest entries first when the hard cache bound is hit", async () => {
    // Fill the cache past capacity with distinct ids inside the window.
    const ids = Array.from({ length: 1100 }, (_, i) => `flood-${i}`);
    for (const id of ids) {
      await bot.handleIncoming(textMessage(id));
    }
    expect(onMessage).toHaveBeenCalledTimes(1100);
    // The oldest ids were evicted: a repeat of an early id must deliver again.
    await bot.handleIncoming(textMessage("flood-0"));
    expect(onMessage).toHaveBeenCalledTimes(1101);
    // A recent id is still deduped.
    await bot.handleIncoming(textMessage("flood-1099"));
    expect(onMessage).toHaveBeenCalledTimes(1101);
  });

  it("stops deduping after stop()", async () => {
    await bot.handleIncoming(textMessage("m1"));
    bot.stop();
    await bot.handleIncoming(textMessage("m1"));
    expect(onMessage).toHaveBeenCalledTimes(2);
  });
});
