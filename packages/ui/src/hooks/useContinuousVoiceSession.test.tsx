/** Verifies useContinuousVoiceSession through the package's configured test harness. */
// @vitest-environment jsdom
//
/**
 * Tests for `useContinuousVoiceSession` — the composition that selects the
 * realtime WS path vs the EXISTING batch path without a second UI surface.
 *
 * These assert the CRITICAL non-regression contract: when the realtime path is
 * not available (flag off / mint 404 / no ids), the composed surface passes the
 * batch state through UNCHANGED and routes start/stop to the batch pause/resume.
 * When realtime is active it wins the status/transcript and routes lifecycle to
 * the realtime client. The batch/realtime states are minimal doubles of the two
 * hooks' PUBLIC shapes (not stubs of the code under test — the code under test
 * is the selection logic in this hook).
 */

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useVoiceLiveActivityMock } = vi.hoisted(() => ({
  useVoiceLiveActivityMock: vi.fn(),
}));

vi.mock("../voice/ios-live-activity", () => ({
  useVoiceLiveActivity: useVoiceLiveActivityMock,
}));

import { useContinuousVoiceSession } from "./useContinuousVoiceSession";
import type { UseRealtimeVoiceSessionState } from "./useRealtimeVoiceSession";

// The batch `ContinuousChatState` type lives in `useContinuousChat`, whose
// runtime module graph transitively pulls a native-plugin chain that isn't
// resolvable in this worktree's symlinked node_modules (a pre-existing install
// artifact, not part of this change). We only need its PUBLIC shape here, so we
// mirror the fields the composition reads. The composition hook itself is fully
// typed against the real `ContinuousChatState` in the source — this local
// mirror is test-scaffolding, not a stub of the code under test.
type ContinuousChatState = Parameters<
  typeof useContinuousVoiceSession
>[0]["batch"];

function makeBatch(over?: Partial<ContinuousChatState>): ContinuousChatState {
  return {
    status: "listening",
    active: true,
    mode: "always-on",
    interimTranscript: "batch interim",
    interrupting: false,
    latency: {
      speechEndToFirstTokenMs: 100,
      speechEndToVoiceStartMs: 200,
      assistantStreamToVoiceStartMs: 50,
      firstSegmentCached: false,
    },
    speaker: null,
    needsAudioUnlock: false,
    micReconnected: false,
    unlockAudio: vi.fn(),
    ttsError: null,
    startTurn: vi.fn(() => ({
      id: "t",
      cancel: vi.fn(),
      isCancelled: () => false,
    })),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function makeRealtime(
  over?: Partial<UseRealtimeVoiceSessionState>,
): UseRealtimeVoiceSessionState {
  return {
    available: false,
    active: false,
    connecting: false,
    status: "idle",
    transcriptPartial: "",
    transcriptFinal: "",
    agentSpeaking: false,
    needsUnlock: false,
    paused: false,
    microphoneMuted: false,
    error: null,
    fallbackReason: null,
    reportFallback: vi.fn(),
    speaker: null,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    bargeIn: vi.fn(),
    toggleMicrophoneMute: vi.fn(),
    unlock: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("useContinuousVoiceSession", () => {
  beforeEach(() => {
    useVoiceLiveActivityMock.mockClear();
  });

  it("passes the batch state through UNCHANGED when realtime is unavailable", () => {
    const batch = makeBatch();
    const realtime = makeRealtime({ available: false });
    const { result } = renderHook(() =>
      useContinuousVoiceSession({ batch, realtime }),
    );
    expect(result.current.realtimeActive).toBe(false);
    expect(result.current.realtimeEligible).toBe(false);
    expect(result.current.status).toBe("listening");
    expect(result.current.interimTranscript).toBe("batch interim");
    expect(result.current.latency.speechEndToVoiceStartMs).toBe(200);
    expect(useVoiceLiveActivityMock).toHaveBeenLastCalledWith({
      active: true,
      status: "listening",
      error: false,
    });
  });

  it("start()/stop() route to the batch pause/resume on the batch path", async () => {
    const batch = makeBatch();
    const realtime = makeRealtime({ available: false });
    const { result } = renderHook(() =>
      useContinuousVoiceSession({ batch, realtime }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(batch.resume).toHaveBeenCalledTimes(1);
    expect(realtime.start).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.stop();
    });
    expect(batch.pause).toHaveBeenCalledTimes(1);
    expect(realtime.stop).not.toHaveBeenCalled();
  });

  it("realtime wins the status + transcript while it is the active path", () => {
    const batch = makeBatch({ interimTranscript: "batch interim" });
    const realtime = makeRealtime({
      available: true,
      active: true,
      status: "speaking",
      transcriptPartial: "rt partial",
      transcriptFinal: "rt final",
      agentSpeaking: true,
    });
    const { result } = renderHook(() =>
      useContinuousVoiceSession({ batch, realtime }),
    );
    expect(result.current.realtimeActive).toBe(true);
    expect(result.current.status).toBe("speaking");
    expect(result.current.interimTranscript).toBe("rt partial");
    expect(result.current.finalTranscript).toBe("rt final");
    expect(result.current.agentSpeaking).toBe(true);
    expect(useVoiceLiveActivityMock).toHaveBeenLastCalledWith({
      active: true,
      status: "speaking",
      error: false,
    });
  });

  it("keeps the committed transcript visible while the EOT request is thinking", () => {
    const batch = makeBatch({ interimTranscript: "batch interim" });
    const realtime = makeRealtime({
      available: true,
      active: true,
      status: "thinking",
      transcriptPartial: "",
      transcriptFinal: "committed request",
    });
    const { result } = renderHook(() =>
      useContinuousVoiceSession({ batch, realtime }),
    );
    expect(result.current.interimTranscript).toBe("committed request");
  });

  it("surfaces realtime autoplay unlock state and action while realtime is active", () => {
    const batch = makeBatch({ needsAudioUnlock: false });
    const realtime = makeRealtime({
      available: true,
      active: true,
      needsUnlock: true,
    });
    const { result } = renderHook(() =>
      useContinuousVoiceSession({ batch, realtime }),
    );

    expect(result.current.needsAudioUnlock).toBe(true);
    act(() => result.current.unlockAudio());
    expect(realtime.unlock).toHaveBeenCalledTimes(1);
    expect(batch.unlockAudio).not.toHaveBeenCalled();
  });

  it("start() routes to realtime.start when available; stop() to realtime.stop when active", async () => {
    const batch = makeBatch();
    const realtime = makeRealtime({ available: true, active: true });
    const { result } = renderHook(() =>
      useContinuousVoiceSession({ batch, realtime }),
    );
    await act(async () => {
      await result.current.start();
    });
    expect(realtime.start).toHaveBeenCalledTimes(1);
    expect(batch.resume).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.stop();
    });
    expect(realtime.stop).toHaveBeenCalledTimes(1);
    expect(batch.pause).not.toHaveBeenCalled();
  });

  it("bargeIn() is a no-op on the batch path and calls realtime.bargeIn when active", () => {
    const batchOnly = renderHook(() =>
      useContinuousVoiceSession({
        batch: makeBatch(),
        realtime: makeRealtime({ available: false }),
      }),
    );
    act(() => batchOnly.result.current.bargeIn());
    // No realtime to barge into; nothing throws.

    const rt = makeRealtime({ available: true, active: true });
    const withRt = renderHook(() =>
      useContinuousVoiceSession({ batch: makeBatch(), realtime: rt }),
    );
    act(() => withRt.result.current.bargeIn());
    expect(rt.bargeIn).toHaveBeenCalledTimes(1);
  });

  it("exposes realtimeConnecting while a started session is pre-live, and stop() cancels it", async () => {
    const batch = makeBatch({ active: false, status: "idle" });
    const realtime = makeRealtime({
      available: true,
      active: false,
      connecting: true,
    });
    const { result } = renderHook(() =>
      useContinuousVoiceSession({ batch, realtime }),
    );
    expect(result.current.realtimeConnecting).toBe(true);
    expect(result.current.realtimeActive).toBe(false);
    expect(useVoiceLiveActivityMock).toHaveBeenLastCalledWith({
      active: false,
      status: "idle",
      error: false,
    });

    // A stop during bring-up must cancel the pending realtime lifecycle, not
    // pause the (disabled) batch path.
    await act(async () => {
      await result.current.stop();
    });
    expect(realtime.stop).toHaveBeenCalledTimes(1);
    expect(batch.pause).not.toHaveBeenCalled();
  });

  it("surfaces the realtime error only (batch ttsError still passes through)", () => {
    const batch = makeBatch({
      ttsError: { engine: "elevenlabs", message: "boom", atMs: 1 },
    });
    const realtime = makeRealtime({
      available: true,
      active: true,
      error: { kind: "permission", message: "blocked", actionable: true },
    });
    const { result } = renderHook(() =>
      useContinuousVoiceSession({ batch, realtime }),
    );
    expect(result.current.realtimeError?.kind).toBe("permission");
    // The fail-closed TTS banner still rides through from the batch state.
    expect(result.current.ttsError?.engine).toBe("elevenlabs");
    expect(useVoiceLiveActivityMock).toHaveBeenLastCalledWith({
      active: true,
      status: "idle",
      error: true,
    });
  });
});
