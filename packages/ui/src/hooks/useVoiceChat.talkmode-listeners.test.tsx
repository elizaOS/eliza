// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Guards ensureTalkModeListeners re-entrancy in useVoiceChat: two overlapping
 * registration passes must serialize through the in-flight-promise ref
 * (talkModeListenersRegistrationRef) rather than both clearing the
 * `handles.length > 0` guard and registering SIX native listeners, three of
 * which would leak forever (double transcripts, un-removable). Drives two
 * concurrent startListening calls against a deferred fake TalkMode plugin and
 * asserts exactly three listeners register and all are removable.
 */

const h = vi.hoisted(() => {
  const state = {
    /** Event name of every addListener call, in order. */
    addListenerEvents: [] as string[],
    /** Deferred resolvers — the test releases addListener results manually. */
    resolvers: [] as Array<() => void>,
    /** Total remove() calls across all handles ever returned. */
    removeCalls: 0,
  };
  const talkModePlugin = {
    addListener: (event: string, _cb: (ev: unknown) => void) => {
      state.addListenerEvents.push(event);
      return new Promise<{ remove: () => Promise<void> }>((resolve) => {
        state.resolvers.push(() =>
          resolve({
            remove: () => {
              state.removeCalls += 1;
              return Promise.resolve();
            },
          }),
        );
      });
    },
    checkPermissions: () =>
      Promise.resolve({
        microphone: "granted",
        speechRecognition: "granted",
      }),
    requestPermissions: () =>
      Promise.resolve({
        microphone: "granted",
        speechRecognition: "granted",
      }),
    start: () => Promise.resolve({ started: true }),
    stop: () => Promise.resolve(),
  };
  return { state, talkModePlugin };
});

// Make shouldPreferNativeTalkMode() true in jsdom (no Capacitor native
// platform here) by pretending to be an Electrobun renderer.
vi.mock("../bridge/electrobun-rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bridge/electrobun-rpc")>()),
  getElectrobunRendererRpc: () => ({}) as never,
}));

vi.mock("../bridge/native-plugins", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bridge/native-plugins")>()),
  getTalkModePlugin: () => h.talkModePlugin as never,
}));

import { useVoiceChat } from "./useVoiceChat";

/** Release deferred addListener resolutions until no new ones appear. */
async function releaseAllListenerRegistrations(): Promise<void> {
  // Enough rounds to drain even a (buggy) double-registration pass, so a
  // regression fails on the count assertion instead of hanging the test.
  for (let round = 0; round < 12; round += 1) {
    for (const resolve of h.state.resolvers.splice(0)) resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("useVoiceChat talk-mode listener registration (FIX 1)", () => {
  beforeEach(() => {
    h.state.addListenerEvents.length = 0;
    h.state.resolvers.length = 0;
    h.state.removeCalls = 0;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("serializes concurrent registration passes — exactly three listeners, all removable", async () => {
    const { result, unmount } = renderHook(() =>
      useVoiceChat({ onTranscript: vi.fn() }),
    );

    // Two overlapping starts: both pass the enabledRef guard (neither has
    // finished), so both reach ensureTalkModeListeners while the first
    // registration pass is still blocked on its deferred addListener.
    const starts: Array<Promise<void>> = [];
    act(() => {
      starts.push(result.current.startListening("push-to-talk"));
      starts.push(result.current.startListening("push-to-talk"));
    });

    await waitFor(() =>
      expect(h.state.addListenerEvents.length).toBeGreaterThanOrEqual(1),
    );
    // Give the second caller ample time to (incorrectly) begin its own pass.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // Only ONE pass may be in flight: a single pending "transcript"
    // registration. Without the in-flight ref this is already
    // ["transcript", "transcript"].
    expect(h.state.addListenerEvents).toEqual(["transcript"]);

    await act(async () => {
      await releaseAllListenerRegistrations();
      await Promise.all(starts);
    });

    // Exactly three listeners — not six.
    expect(h.state.addListenerEvents).toEqual([
      "transcript",
      "error",
      "stateChange",
    ]);
    expect(result.current.isListening).toBe(true);
    expect(result.current.captureMode).toBe("push-to-talk");

    // A later start with listeners already registered must not re-register.
    await act(async () => {
      await result.current.stopListening();
    });
    await act(async () => {
      const again = result.current.startListening("push-to-talk");
      await releaseAllListenerRegistrations();
      await again;
    });
    expect(h.state.addListenerEvents).toEqual([
      "transcript",
      "error",
      "stateChange",
    ]);

    // Every registered handle is removable via removeTalkModeListeners
    // (unmount cleanup) — nothing leaked outside talkModeHandlesRef.
    unmount();
    await waitFor(() => expect(h.state.removeCalls).toBe(3));
  });
});
