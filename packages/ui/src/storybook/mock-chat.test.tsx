// @vitest-environment jsdom

/**
 * Exercises the Design Lab chat controller's seeded, sent, appended, streamed,
 * and reset states with React's real hook lifecycle and deterministic timers.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_SEED,
  CHAT_SEED_FIRST_RUN,
  CHAT_SEED_MANY,
  type MockChatConfig,
  seedFor,
  useMockChat,
} from "../../stories/src/lab/mock-chat";

const BASE_CONFIG: MockChatConfig = {
  seed: "conversation",
  phase: "summoned",
  recording: false,
  transcribing: false,
  speaking: false,
  noProvider: false,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Design Lab mock chat", () => {
  it("returns isolated copies of every supported transcript seed", () => {
    expect(seedFor("conversation")).toEqual(CHAT_SEED);
    expect(seedFor("long")).toEqual(CHAT_SEED_MANY);
    expect(seedFor("first-run")).toEqual(CHAT_SEED_FIRST_RUN);
    expect(seedFor("empty")).toEqual([]);
    expect(seedFor("conversation")).not.toBe(CHAT_SEED);
  });

  it("drives send, reply, append, stream, and reset through one controller", () => {
    vi.useFakeTimers();
    const openEvents = vi.fn();
    window.addEventListener("eliza:chat:open", openEvents);
    const { result, unmount } = renderHook(() => useMockChat(BASE_CONFIG));

    act(() => result.current.sendUser("  hello lab  "));
    expect(result.current.controller.messages.at(-1)?.content).toBe(
      "hello lab",
    );
    expect(result.current.controller.phase).toBe("responding");

    act(() => vi.advanceTimersByTime(500));
    expect(result.current.controller.messages.at(-1)?.role).toBe("assistant");
    expect(result.current.controller.phase).toBe("summoned");

    act(() => result.current.appendAssistant("manual reply"));
    expect(result.current.controller.messages.at(-1)?.content).toBe(
      "manual reply",
    );

    act(() => result.current.streamReply());
    expect(result.current.controller.phase).toBe("responding");
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.controller.messages.at(-1)?.content).toContain(
      "Streaming a reply token by token",
    );
    expect(result.current.controller.phase).toBe("summoned");

    act(() => result.current.reset());
    expect(result.current.controller.messages).toEqual(CHAT_SEED);
    expect(openEvents).toHaveBeenCalledTimes(3);

    unmount();
    window.removeEventListener("eliza:chat:open", openEvents);
  });

  it("reseeds when the selected fixture changes", () => {
    const { result, rerender } = renderHook(
      ({ config }: { config: MockChatConfig }) => useMockChat(config),
      { initialProps: { config: BASE_CONFIG } },
    );

    rerender({
      config: { ...BASE_CONFIG, seed: "first-run", phase: "responding" },
    });

    expect(result.current.controller.messages).toEqual(CHAT_SEED_FIRST_RUN);
    expect(result.current.controller.phase).toBe("responding");
  });
});
