/**
 * Verifies the cross-window tab-sync hook through renderHook against a
 * scripted BroadcastChannel transport: the inert fallback when the API is
 * absent, payload shapes published to peer windows, guarded routing of
 * inbound frames to the latest handler identities, and channel teardown on
 * unmount. Only the platform transport is doubled; all hook logic is real.
 */
// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UseTabSyncOptions, useTabSync } from "./useTabSync";

class FakeBroadcastChannel {
  private static readonly opened: FakeBroadcastChannel[] = [];

  readonly name: string;
  closed = false;
  readonly posted: unknown[] = [];
  private readonly listeners: Array<{
    type: string;
    callback: EventListenerOrEventListenerObject;
  }> = [];

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.opened.push(this);
  }

  static get openedChannels(): readonly FakeBroadcastChannel[] {
    return FakeBroadcastChannel.opened;
  }

  static reset(): void {
    FakeBroadcastChannel.opened.length = 0;
  }

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
  ): void {
    if (callback) this.listeners.push({ type, callback });
  }

  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
  ): void {
    if (!callback) return;
    const index = this.listeners.findIndex(
      (entry) => entry.type === type && entry.callback === callback,
    );
    if (index !== -1) this.listeners.splice(index, 1);
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
    for (const peer of FakeBroadcastChannel.opened) {
      if (peer === this || peer.closed || peer.name !== this.name) continue;
      peer.deliver(message);
    }
  }

  close(): void {
    this.closed = true;
    this.listeners.length = 0;
  }

  private deliver(data: unknown): void {
    const event = new MessageEvent("message", { data });
    for (const { type, callback } of [...this.listeners]) {
      if (type !== "message") continue;
      if (typeof callback === "function") callback(event);
      else callback.handleEvent(event);
    }
  }
}

function requireOpenedChannel(): FakeBroadcastChannel {
  const [channel] = FakeBroadcastChannel.openedChannels;
  if (!channel) throw new Error("expected a hook-opened channel");
  return channel;
}

function remoteWindow(): FakeBroadcastChannel {
  return new FakeBroadcastChannel(requireOpenedChannel().name);
}

const globalWithChannel = globalThis as { BroadcastChannel?: unknown };
let originalBroadcastChannel: unknown;

describe("useTabSync", () => {
  beforeEach(() => {
    originalBroadcastChannel = globalWithChannel.BroadcastChannel;
  });

  afterEach(() => {
    cleanup();
    globalWithChannel.BroadcastChannel = originalBroadcastChannel;
    FakeBroadcastChannel.reset();
  });

  describe("without BroadcastChannel", () => {
    beforeEach(() => {
      globalWithChannel.BroadcastChannel = undefined;
    });

    it("reports disabled and never opens a channel", () => {
      const { result } = renderHook(() => useTabSync());
      expect(result.current.enabled).toBe(false);
      expect(FakeBroadcastChannel.openedChannels).toHaveLength(0);
    });

    it("publishing is an inert no-op instead of a crash", () => {
      const { result } = renderHook(() => useTabSync());
      expect(() =>
        act(() => {
          result.current.publishActiveConversation("conv-1");
          result.current.publishPrefs({ language: "de" });
        }),
      ).not.toThrow();
      expect(FakeBroadcastChannel.openedChannels).toHaveLength(0);
    });

    it("hands every consumer the same stable noop api object", () => {
      const first = renderHook(() => useTabSync());
      const second = renderHook(() => useTabSync());
      first.rerender();
      expect(first.result.current).toBe(second.result.current);
      first.unmount();
      second.unmount();
    });
  });

  describe("with BroadcastChannel available", () => {
    beforeEach(() => {
      globalWithChannel.BroadcastChannel =
        FakeBroadcastChannel as unknown as typeof BroadcastChannel;
    });

    it("reports enabled and keeps exactly one channel across re-renders", () => {
      const view = renderHook(() => useTabSync());
      view.rerender();
      view.rerender();
      expect(view.result.current.enabled).toBe(true);
      expect(FakeBroadcastChannel.openedChannels).toHaveLength(1);
    });

    it("broadcasts the active-conversation payload peers consume", () => {
      const { result } = renderHook(() => useTabSync());
      act(() => result.current.publishActiveConversation("conv-42"));
      expect(requireOpenedChannel().posted).toEqual([
        { kind: "active-conversation", conversationId: "conv-42" },
      ]);
    });

    it("broadcasts null to clear the active conversation everywhere", () => {
      const { result } = renderHook(() => useTabSync());
      act(() => result.current.publishActiveConversation(null));
      expect(requireOpenedChannel().posted).toEqual([
        { kind: "active-conversation", conversationId: null },
      ]);
    });

    it("broadcasts prefs updates with their payload intact", () => {
      const { result } = renderHook(() => useTabSync());
      act(() => result.current.publishPrefs({ language: "de" }));
      expect(requireOpenedChannel().posted).toEqual([
        { kind: "prefs", prefs: { language: "de" } },
      ]);
    });

    it("mirrors another window's conversation switch into onActiveConversation", () => {
      const received: Array<string | null> = [];
      renderHook(() =>
        useTabSync({ onActiveConversation: (id) => received.push(id) }),
      );
      remoteWindow().postMessage({
        kind: "active-conversation",
        conversationId: "conv-7",
      });
      expect(received).toEqual(["conv-7"]);
    });

    it("passes a null conversation id through to the handler untouched", () => {
      const onActiveConversation = vi.fn();
      renderHook(() => useTabSync({ onActiveConversation }));
      remoteWindow().postMessage({
        kind: "active-conversation",
        conversationId: null,
      });
      expect(onActiveConversation).toHaveBeenCalledTimes(1);
      expect(onActiveConversation).toHaveBeenCalledWith(null);
    });

    it("mirrors another window's prefs into onPrefs", () => {
      const onPrefs = vi.fn();
      renderHook(() => useTabSync({ onPrefs }));
      remoteWindow().postMessage({
        kind: "prefs",
        prefs: { language: "fr" },
      });
      expect(onPrefs).toHaveBeenCalledTimes(1);
      expect(onPrefs).toHaveBeenCalledWith({ language: "fr" });
    });

    it("drops malformed frames without touching either handler", () => {
      const onActiveConversation = vi.fn();
      const onPrefs = vi.fn();
      renderHook(() => useTabSync({ onActiveConversation, onPrefs }));
      const remote = remoteWindow();
      const malformedFrames: unknown[] = [
        42,
        null,
        "active-conversation",
        {},
        { kind: "unknown" },
        { kind: "active-conversation", conversationId: 7 },
        { kind: "active-conversation" },
        { kind: "prefs", prefs: null },
        { kind: "prefs", prefs: 3 },
      ];
      for (const frame of malformedFrames) remote.postMessage(frame);
      expect(onActiveConversation).not.toHaveBeenCalled();
      expect(onPrefs).not.toHaveBeenCalled();
    });

    it("routes frames to the newest handler identity without resubscribing", () => {
      const firstHandler = vi.fn();
      const secondHandler = vi.fn();
      const view = renderHook((props: UseTabSyncOptions) => useTabSync(props), {
        initialProps: { onActiveConversation: firstHandler },
      });
      view.rerender({ onActiveConversation: secondHandler });
      expect(FakeBroadcastChannel.openedChannels).toHaveLength(1);
      remoteWindow().postMessage({
        kind: "active-conversation",
        conversationId: "conv-8",
      });
      expect(firstHandler).not.toHaveBeenCalled();
      expect(secondHandler).toHaveBeenCalledWith("conv-8");
    });

    it("closes its channel on unmount and goes quiet afterwards", () => {
      const onActiveConversation = vi.fn();
      const view = renderHook(() => useTabSync({ onActiveConversation }));
      const mine = requireOpenedChannel();
      view.unmount();
      expect(mine.closed).toBe(true);
      const remote = new FakeBroadcastChannel(mine.name);
      remote.postMessage({
        kind: "active-conversation",
        conversationId: "late",
      });
      expect(onActiveConversation).not.toHaveBeenCalled();
      expect(() =>
        act(() => view.result.current.publishActiveConversation("stray")),
      ).not.toThrow();
      expect(remote.posted).toEqual([
        { kind: "active-conversation", conversationId: "late" },
      ]);
    });
  });
});
