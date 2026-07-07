// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../api";
import { APP_PAUSE_EVENT, APP_RESUME_EVENT } from "../events";
import type { LoadConversationMessagesResult } from "./internal";
import {
  RESUME_DEBOUNCE_MS,
  useAppLifecycleEvents,
} from "./useAppLifecycleEvents";

/**
 * Pins the resume-from-background reliability wiring (dossier D1/D2/D3):
 *  - APP_RESUME_EVENT (dispatched on the web PWA too, not just native) forces
 *    a WS reconnect (client.resetConnection) AND refetches the active
 *    conversation tail so messages missed while backgrounded appear.
 *  - The resume sequence is debounced so rapid fg/bg flips (or a
 *    visibilitychange + bfcache pageshow in the same tick) run once.
 *  - A persisted `pageshow` (iOS bfcache restore) also triggers a resume; a
 *    non-persisted pageshow does not.
 *  - Listeners detach on unmount (no leak).
 *  - APP_PAUSE persists the active conversation id + aborts in-flight streams.
 * Real hook under jsdom with fake timers to observe the debounce.
 */

const mocks = vi.hoisted(() => ({
  client: {
    resetConnection: vi.fn(),
    fetch: vi.fn(async () => ({ ok: true })),
    getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
  },
}));

vi.mock("../api", () => ({
  client: mocks.client,
}));

function makeMessages(...ms: ConversationMessage[]): ConversationMessage[] {
  return ms;
}

interface SetupOpts {
  activeId?: string | null;
  messages?: ConversationMessage[];
}

function setup(opts: SetupOpts = {}) {
  const activeConversationIdRef = {
    // `null` is a meaningful value (no active conversation), so only default
    // when the key is absent — nullish-coalescing would swallow an explicit null.
    current: "activeId" in opts ? (opts.activeId ?? null) : "conv-1",
  } as MutableRefObject<string | null>;
  const conversationMessagesRef = {
    current: opts.messages ?? [],
  } as MutableRefObject<ConversationMessage[]>;
  const chatAbortRef = {
    current: null,
  } as MutableRefObject<AbortController | null>;
  const setConversationMessages = vi.fn();
  const loadConversationMessages = vi.fn(
    async (): Promise<LoadConversationMessagesResult> => ({ ok: true }),
  );

  const view = renderHook(() =>
    useAppLifecycleEvents({
      activeConversationIdRef,
      conversationMessagesRef,
      chatAbortRef,
      setConversationMessages,
      loadConversationMessages,
    }),
  );

  return {
    activeConversationIdRef,
    conversationMessagesRef,
    chatAbortRef,
    setConversationMessages,
    loadConversationMessages,
    view,
  };
}

function dispatchResume(): void {
  document.dispatchEvent(new Event(APP_RESUME_EVENT));
}

function dispatchPause(): void {
  document.dispatchEvent(new Event(APP_PAUSE_EVENT));
}

function dispatchPageShow(persisted: boolean): void {
  // jsdom doesn't construct PageTransitionEvent with `persisted`; synthesize it.
  const event = new Event("pageshow") as PageTransitionEvent & {
    persisted: boolean;
  };
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

describe("useAppLifecycleEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.client.resetConnection.mockClear();
    mocks.client.fetch.mockClear();
    mocks.client.getBaseUrl.mockReturnValue("http://127.0.0.1:31337");
    window.localStorage.clear();
  });

  afterEach(() => {
    // Unmount every rendered hook FIRST (detaches its listeners + clears any
    // pending debounce timer) so a leftover timer from this test can't fire
    // into the next one's freshly-cleared mocks.
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("on resume: forces WS reconnect + refetches the active conversation tail (D2)", () => {
    const { loadConversationMessages } = setup({ activeId: "conv-42" });

    dispatchResume();
    // Debounced — nothing fires synchronously.
    expect(mocks.client.resetConnection).not.toHaveBeenCalled();
    expect(loadConversationMessages).not.toHaveBeenCalled();

    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS);

    expect(mocks.client.resetConnection).toHaveBeenCalledTimes(1);
    expect(loadConversationMessages).toHaveBeenCalledTimes(1);
    expect(loadConversationMessages).toHaveBeenCalledWith("conv-42");
  });

  it("debounces rapid fg/bg flips into a single reconnect + refetch", () => {
    const { loadConversationMessages } = setup();

    dispatchResume();
    vi.advanceTimersByTime(100);
    dispatchResume();
    vi.advanceTimersByTime(100);
    dispatchResume();
    // Still within the debounce window — not fired yet.
    expect(mocks.client.resetConnection).not.toHaveBeenCalled();

    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS);

    expect(mocks.client.resetConnection).toHaveBeenCalledTimes(1);
    expect(loadConversationMessages).toHaveBeenCalledTimes(1);
  });

  it("treats a persisted pageshow (bfcache restore) as a resume (D3)", () => {
    const { loadConversationMessages } = setup({ activeId: "conv-bfcache" });

    dispatchPageShow(true);
    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS);

    expect(mocks.client.resetConnection).toHaveBeenCalledTimes(1);
    expect(loadConversationMessages).toHaveBeenCalledWith("conv-bfcache");
  });

  it("ignores a non-persisted pageshow (normal load already connects)", () => {
    const { loadConversationMessages } = setup();

    dispatchPageShow(false);
    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS);

    expect(mocks.client.resetConnection).not.toHaveBeenCalled();
    expect(loadConversationMessages).not.toHaveBeenCalled();
  });

  it("coalesces a visibilitychange resume + bfcache pageshow in the same tick into one run", () => {
    const { loadConversationMessages } = setup();

    dispatchResume();
    dispatchPageShow(true);
    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS);

    expect(mocks.client.resetConnection).toHaveBeenCalledTimes(1);
    expect(loadConversationMessages).toHaveBeenCalledTimes(1);
  });

  it("skips the tail refetch when there is no active conversation, still reconnects", () => {
    const { loadConversationMessages } = setup({ activeId: null });

    dispatchResume();
    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS);

    expect(mocks.client.resetConnection).toHaveBeenCalledTimes(1);
    expect(loadConversationMessages).not.toHaveBeenCalled();
  });

  it("does not probe /api/health against the agentless Cloud control plane", () => {
    mocks.client.getBaseUrl.mockReturnValue("https://api.elizacloud.ai");
    const { loadConversationMessages } = setup({ activeId: "conv-cloud" });

    dispatchResume();
    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS);

    expect(mocks.client.fetch).not.toHaveBeenCalled();
    expect(mocks.client.resetConnection).not.toHaveBeenCalled();
    expect(loadConversationMessages).not.toHaveBeenCalled();
  });

  it("marks a stale empty streaming assistant placeholder as interrupted on resume", () => {
    const { setConversationMessages } = setup({
      messages: makeMessages({
        id: "m1",
        role: "assistant",
        text: "",
      } as ConversationMessage),
    });

    dispatchResume();
    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS);

    expect(setConversationMessages).toHaveBeenCalledTimes(1);
    const updater = setConversationMessages.mock.calls[0][0] as (
      prev: ConversationMessage[],
    ) => ConversationMessage[];
    const next = updater([
      { id: "m1", role: "assistant", text: "" } as ConversationMessage,
    ]);
    expect(next[0].interrupted).toBe(true);
  });

  it("does not touch messages when the last turn is not an empty placeholder", () => {
    const { setConversationMessages } = setup({
      messages: makeMessages({
        id: "m1",
        role: "assistant",
        text: "hello",
      } as ConversationMessage),
    });

    dispatchResume();
    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS);

    expect(setConversationMessages).not.toHaveBeenCalled();
  });

  it("survives a throwing resetConnection and still refetches the tail", () => {
    mocks.client.resetConnection.mockImplementationOnce(() => {
      throw new Error("reconnect boom");
    });
    const { loadConversationMessages } = setup({ activeId: "conv-x" });

    dispatchResume();
    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS);

    expect(loadConversationMessages).toHaveBeenCalledWith("conv-x");
  });

  it("detaches resume + pageshow listeners on unmount (no leak, no post-unmount fire)", () => {
    const { loadConversationMessages, view } = setup();

    view.unmount();

    dispatchResume();
    dispatchPageShow(true);
    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS * 2);

    expect(mocks.client.resetConnection).not.toHaveBeenCalled();
    expect(loadConversationMessages).not.toHaveBeenCalled();
  });

  it("cancels a pending debounced resume if the hook unmounts mid-window", () => {
    const { loadConversationMessages, view } = setup();

    dispatchResume();
    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS / 2);
    view.unmount();
    vi.advanceTimersByTime(RESUME_DEBOUNCE_MS);

    expect(mocks.client.resetConnection).not.toHaveBeenCalled();
    expect(loadConversationMessages).not.toHaveBeenCalled();
  });

  it("on pause: persists the active conversation id + aborts an in-flight stream", () => {
    const controller = new AbortController();
    const { chatAbortRef } = setup({ activeId: "conv-persist" });
    chatAbortRef.current = controller;

    dispatchPause();

    expect(controller.signal.aborted).toBe(true);
    expect(window.localStorage.getItem("eliza:chat:activeConversationId")).toBe(
      "conv-persist",
    );
  });
});
