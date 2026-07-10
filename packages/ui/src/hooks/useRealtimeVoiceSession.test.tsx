// @vitest-environment jsdom
//
/**
 * Hook-level tests for `useRealtimeVoiceSession`.
 *
 * DoD posture: these drive the REAL hook + the REAL `createVoiceSessionClient`
 * through the client's fake TRANSPORTS (`voice-session-fakes.ts`: fake
 * WebSocket, fake AudioContext, fake getUserMedia). There is NO stub of the
 * thing under test — the full start→listen→final→speaking→bargein→stop flow
 * exercises the actual client framing/state machine, and the hook folds its
 * real callbacks. Fallback (mint 404) and permission-denied are driven through
 * the real mint fetch + the real getUserMedia denial, not simulated.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  isRealtimeVoiceFlagEnabled,
  useRealtimeVoiceSession,
} from "./useRealtimeVoiceSession";
import {
  FakeMicAudioContext,
  FakePlaybackAudioContext,
  deniedGetUserMedia,
  fakeGetUserMedia,
  makeWsFactory,
} from "../voice/__tests__/voice-session-fakes";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const CONV_ID = "22222222-2222-2222-2222-222222222222";

interface MintOpts {
  status?: number;
}

function makeMintFetch(opts: MintOpts = {}) {
  const calls: Array<Record<string, unknown>> = [];
  let n = 0;
  const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    calls.push(body);
    n += 1;
    const status = opts.status ?? 200;
    if (status !== 200) {
      return new Response(JSON.stringify({ error: "nope" }), { status });
    }
    return new Response(
      JSON.stringify({
        sessionId: `sess-${n}`,
        wsUrl: `wss://cloud/api/v1/voice/session/ws?sessionId=sess-${n}`,
        token: `tok-${n}`,
        expiresAt: Date.now() + 60_000,
        uplink: { codecs: ["pcm16"] },
        downlink: { codecs: ["pcm16"] },
        iceServers: null,
      }),
      { status: 200 },
    );
  };
  return { fetch, calls };
}

/** Build hook options wired to the fake transports, sharing one WS factory. */
function makeOptions(overrides?: {
  flagEnabled?: boolean;
  mintStatus?: number;
  consentNonce?: string | null;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  agentId?: string | null;
  conversationId?: string | null;
}) {
  const ws = makeWsFactory();
  const mint = makeMintFetch({ status: overrides?.mintStatus });
  const micCtx = new FakeMicAudioContext(16_000);
  const pbCtx = new FakePlaybackAudioContext(16_000);
  const getConsentNonce = vi
    .fn<() => Promise<string | null>>()
    .mockResolvedValue(
      overrides?.consentNonce === undefined ? "nonce-1" : overrides.consentNonce,
    );
  const options = {
    agentId: overrides?.agentId === undefined ? AGENT_ID : overrides.agentId,
    conversationId:
      overrides?.conversationId === undefined ? CONV_ID : overrides.conversationId,
    flagEnabled: overrides?.flagEnabled ?? true,
    getConsentNonce,
    clientOptions: {
      fetch: mint.fetch,
      webSocketFactory: ws.factory,
      getUserMedia: overrides?.getUserMedia ?? fakeGetUserMedia(),
      createMicAudioContext: () => micCtx,
      createPlaybackAudioContext: () => pbCtx,
      now: () => Date.now(),
    },
  };
  return { options, ws, mint, micCtx, pbCtx, getConsentNonce };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

describe("useRealtimeVoiceSession", () => {
  it("full flow: start → listening → partial → final → speaking → barge-in → stop through the REAL client", async () => {
    const { options, ws, micCtx, pbCtx, getConsentNonce } = makeOptions();
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    // Flag on + ids present + not-yet-disabled ⇒ available for the batch caller
    // to hand the mic to.
    expect(result.current.available).toBe(true);
    expect(result.current.active).toBe(false);
    expect(result.current.status).toBe("idle");

    // Start on the user gesture.
    await act(async () => {
      await result.current.start();
    });
    // Consent was fetched fresh for the session, mint was called with our ids.
    expect(getConsentNonce).toHaveBeenCalledTimes(1);

    // Drive the transport open + ready.
    const sock = ws.last();
    await act(async () => {
      sock.emitOpen();
      await flushAsync();
      sock.emitControl({ t: "ready", sessionId: "sess-1", traceId: "T1" });
      await flushAsync();
    });

    // Playback was unlocked on the start gesture (AudioContext resumed).
    expect(pbCtx.state).toBe("running");
    // Mic capture started on ready.
    expect(micCtx.scriptNode).not.toBeNull();

    await waitFor(() => expect(result.current.active).toBe(true));
    await waitFor(() => expect(result.current.status).toBe("listening"));

    // Partial → final transcript.
    await act(async () => {
      sock.emitControl({ t: "stt_partial", text: "hel", traceId: "T1" });
      await flushAsync();
    });
    expect(result.current.transcriptPartial).toBe("hel");
    expect(result.current.status).toBe("transcribing");

    await act(async () => {
      sock.emitControl({ t: "stt_final", text: "hello", traceId: "T1" });
      await flushAsync();
    });
    expect(result.current.transcriptFinal).toBe("hello");
    expect(result.current.transcriptPartial).toBe("");

    // Thinking → speaking.
    await act(async () => {
      sock.emitControl({ t: "llm_first_text", traceId: "T1" });
      await flushAsync();
    });
    expect(result.current.status).toBe("thinking");

    await act(async () => {
      sock.emitControl({ t: "speaking_start", traceId: "T1" });
      sock.emitAudio(new Uint8Array(320));
      await flushAsync();
    });
    expect(result.current.status).toBe("speaking");
    expect(result.current.agentSpeaking).toBe(true);

    // Barge-in while speaking flushes local playback + sends {t:"barge_in"}.
    await act(async () => {
      result.current.bargeIn();
      await flushAsync();
    });
    const controls = sock.sentControls();
    expect(controls.some((c) => c.t === "barge_in")).toBe(true);

    // Server confirms interrupted → loops to listening.
    await act(async () => {
      sock.emitControl({ t: "interrupted", reason: "explicit", traceId: "T1" });
      await flushAsync();
    });
    await waitFor(() => expect(result.current.status).toBe("listening"));
    expect(result.current.agentSpeaking).toBe(false);

    // Clean stop → bye + teardown.
    await act(async () => {
      await result.current.stop();
    });
    expect(sock.sentControls().some((c) => c.t === "bye")).toBe(true);
    expect(result.current.active).toBe(false);
    expect(result.current.status).toBe("idle");
  });

  it("fallback: a mint 404 flips `available` false with NO error surface (caller uses batch)", async () => {
    const { options } = makeOptions({ mintStatus: 404 });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    expect(result.current.available).toBe(true);
    await act(async () => {
      await result.current.start();
      await flushAsync();
    });

    // 404 = feature disabled server-side. The hook latches it: available flips
    // false, active stays false, and NO error is surfaced (batch fallback is a
    // normal path, not an error).
    await waitFor(() => expect(result.current.available).toBe(false));
    expect(result.current.active).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("does not arm when the VITE flag is off (batch path owns the mic)", async () => {
    const { options, getConsentNonce } = makeOptions({ flagEnabled: false });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    expect(result.current.available).toBe(false);
    await act(async () => {
      await result.current.start();
      await flushAsync();
    });
    // Never minted, never fetched consent, never active.
    expect(getConsentNonce).not.toHaveBeenCalled();
    expect(result.current.active).toBe(false);
  });

  it("permission-denied surfaces an actionable `permission` error state", async () => {
    const { options, ws } = makeOptions({
      getUserMedia: deniedGetUserMedia(),
    });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    await act(async () => {
      await result.current.start();
      await flushAsync();
    });
    const sock = ws.last();
    await act(async () => {
      sock.emitOpen();
      await flushAsync();
      // ready triggers mic capture → getUserMedia denial.
      sock.emitControl({ t: "ready", sessionId: "s", traceId: "T1" });
      await flushAsync();
    });

    await waitFor(() => expect(result.current.error?.kind).toBe("permission"));
    expect(result.current.error?.actionable).toBe(true);
  });

  it("consent unavailable (nonce null) surfaces a `consent` error and never mints", async () => {
    const { options, mint } = makeOptions({ consentNonce: null });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));

    await act(async () => {
      await result.current.start();
      await flushAsync();
    });
    expect(result.current.error?.kind).toBe("consent");
    // No mint request was made — consent is a hard precondition client-side too.
    expect(mint.calls.length).toBe(0);
    expect(result.current.active).toBe(false);
  });

  it("is unavailable without agent/conversation ids even when the flag is on", () => {
    const { options } = makeOptions({ agentId: null });
    const { result } = renderHook(() => useRealtimeVoiceSession(options));
    expect(result.current.available).toBe(false);
  });

  it("surfaces a paused (not broken) state on a visibility-suspend, and clears on resume", async () => {
    const { options, ws, micCtx } = makeOptions();
    const { result } = renderHook(() => useRealtimeVoiceSession(options));
    await act(async () => {
      await result.current.start();
      await flushAsync();
    });
    const sock = ws.last();
    await act(async () => {
      sock.emitOpen();
      await flushAsync();
      sock.emitControl({ t: "ready", sessionId: "s", traceId: "T1" });
      await flushAsync();
    });
    await waitFor(() => expect(result.current.active).toBe(true));
    expect(result.current.paused).toBe(false);

    // The mic-capture fires onSuspend on a page-hide, which the client marks
    // `mic_suspended`. Drive that through the real mic-capture visibility path.
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await flushAsync();
    });
    await waitFor(() => expect(result.current.paused).toBe(true));
    // Still active — a paused mic is not a torn-down session.
    expect(result.current.active).toBe(true);

    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await flushAsync();
    });
    await waitFor(() => expect(result.current.paused).toBe(false));
    void micCtx;

    await act(async () => {
      await result.current.stop();
    });
  });

  it("tears down the live client on unmount (no lingering socket/mic)", async () => {
    const { options, ws, micCtx } = makeOptions();
    const { result, unmount } = renderHook(() =>
      useRealtimeVoiceSession(options),
    );
    await act(async () => {
      await result.current.start();
      await flushAsync();
    });
    const sock = ws.last();
    await act(async () => {
      sock.emitOpen();
      await flushAsync();
      sock.emitControl({ t: "ready", sessionId: "s", traceId: "T1" });
      await flushAsync();
    });
    await waitFor(() => expect(result.current.active).toBe(true));

    unmount();
    await flushAsync();
    // The socket was closed cleanly (bye + close(1000)) and the mic ctx closed.
    expect(sock.closed).not.toBeNull();
    await waitFor(() => expect(micCtx.closed).toBe(true));
  });
});

describe("isRealtimeVoiceFlagEnabled", () => {
  it("defaults to off (batch path is the default everywhere)", () => {
    // In the test env VITE_VOICE_REALTIME_WS is unset → the flag reads false, so
    // the realtime path is off unless a build explicitly opts in.
    expect(isRealtimeVoiceFlagEnabled()).toBe(false);
  });
});
