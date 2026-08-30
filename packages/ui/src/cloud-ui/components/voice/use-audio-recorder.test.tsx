/**
 * Deterministic hook tests verify recorder acquisition, cleanup, and teardown failure handling.
 */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAudioRecorder } from "./use-audio-recorder";

const reportRendererDiagnostic = vi.hoisted(() => vi.fn());

vi.mock("../../../utils/renderer-diagnostics", () => ({
  reportRendererDiagnostic,
}));

type RecorderListener = (event: Event & { data?: Blob }) => void;

/**
 * Spec-faithful fake: stop() flips state to "inactive" synchronously but, like
 * a real MediaRecorder, delivers the final `dataavailable` and terminal `stop`
 * events on a later microtask. `emitData` queues an interim chunk the same way.
 */
class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }

  static instances: FakeMediaRecorder[] = [];

  state: RecordingState = "inactive";
  readonly listeners = new Map<string, RecorderListener[]>();
  readonly stopCall = vi.fn();

  dispatch(type: string, data?: Blob): void {
    const event = new Event(type) as Event & { data?: Blob };
    if (data) {
      event.data = data;
    }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  emitData(data: Blob): void {
    queueMicrotask(() => this.dispatch("dataavailable", data));
  }

  stop(): void {
    this.stopCall();
    if (this.state === "inactive") {
      return;
    }
    this.state = "inactive";
    queueMicrotask(() => {
      this.dispatch("dataavailable", new Blob(["-fin"]));
      this.dispatch("stop");
    });
  }

  constructor(_stream: MediaStream) {
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as RecorderListener);
    this.listeners.set(type, listeners);
  }

  start(): void {
    this.state = "recording";
  }

  pause(): void {
    this.state = "paused";
  }

  resume(): void {
    this.state = "recording";
  }
}

function installRecorder(
  getUserMedia: () => Promise<MediaStream>,
  Recorder: typeof FakeMediaRecorder = FakeMediaRecorder,
): void {
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(getUserMedia) },
  });
}

function createStream(...tracks: Array<{ stop: () => void }>): MediaStream {
  return {
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

afterEach(() => {
  FakeMediaRecorder.instances = [];
  reportRendererDiagnostic.mockReset();
  vi.unstubAllGlobals();
});

describe("useAudioRecorder", () => {
  it("remains usable across React Strict Mode's setup-cleanup replay", async () => {
    const stopTrack = vi.fn();
    installRecorder(async () => createStream({ stop: stopTrack }));

    const { result } = renderHook(() => useAudioRecorder(), {
      reactStrictMode: true,
    });
    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.isRecording).toBe(true);
    await act(async () => {
      result.current.stopRecording();
    });
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("stops a stream that resolves after the hook unmounts", async () => {
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    const streamPromise = new Promise<MediaStream>((resolve) => {
      resolveStream = resolve;
    });
    const stop = vi.fn();
    installRecorder(() => streamPromise);

    const { result, unmount } = renderHook(() => useAudioRecorder());
    let startPromise: Promise<void> | undefined;
    act(() => {
      startPromise = result.current.startRecording();
    });
    unmount();

    resolveStream?.(createStream({ stop }));
    await act(async () => {
      await startPromise;
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it("rejects a constructor that returns a partial recorder and releases the stream", async () => {
    const stop = vi.fn();
    function PartialRecorder(): object {
      return {
        addEventListener: vi.fn(),
        start: vi.fn(),
      };
    }
    Object.assign(PartialRecorder, { isTypeSupported: () => true });
    Object.assign(PartialRecorder.prototype, {
      addEventListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    });
    installRecorder(
      async () => createStream({ stop }),
      PartialRecorder as unknown as typeof FakeMediaRecorder,
    );

    const { result } = renderHook(() => useAudioRecorder());
    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.isRecording).toBe(false);
    expect(result.current.error).toBe(
      "Failed to start recording. Please try again.",
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it("releases every track when recorder startup and recorder teardown throw", async () => {
    class ThrowingMediaRecorder extends FakeMediaRecorder {
      override start(): void {
        this.state = "recording";
        throw new Error("start failed");
      }

      override stop(): void {
        this.stopCall();
        throw new Error("stop failed");
      }
    }
    const firstStop = vi.fn(() => {
      throw new Error("track failed");
    });
    const secondStop = vi.fn();
    installRecorder(
      async () => createStream({ stop: firstStop }, { stop: secondStop }),
      ThrowingMediaRecorder,
    );

    const { result } = renderHook(() => useAudioRecorder());
    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.isRecording).toBe(false);
    expect(firstStop).toHaveBeenCalledOnce();
    expect(secondStop).toHaveBeenCalledOnce();
    expect(reportRendererDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "voice.recording.start.cleanup" }),
    );
  });

  it("stops an active recorder once and makes repeated stop calls harmless", async () => {
    const stopTrack = vi.fn();
    installRecorder(async () => createStream({ stop: stopTrack }));

    const { result } = renderHook(() => useAudioRecorder());
    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.isRecording).toBe(true);

    await act(async () => {
      result.current.stopRecording();
      result.current.stopRecording();
    });

    expect(FakeMediaRecorder.instances[0]?.stopCall).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(result.current.isRecording).toBe(false);
  });

  it("coalesces overlapping start calls into one microphone acquisition", async () => {
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
        }),
    );
    const stopTrack = vi.fn();
    installRecorder(getUserMedia);

    const { result } = renderHook(() => useAudioRecorder());
    let firstStart: Promise<void> | undefined;
    let secondStart: Promise<void> | undefined;
    act(() => {
      firstStart = result.current.startRecording();
      secondStart = result.current.startRecording();
    });
    expect(getUserMedia).toHaveBeenCalledOnce();

    resolveStream?.(createStream({ stop: stopTrack }));
    await act(async () => {
      await Promise.all([firstStart, secondStart]);
    });
    expect(result.current.isRecording).toBe(true);

    await act(async () => {
      result.current.stopRecording();
    });
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("ignores a delayed stop event from an older recorder session", async () => {
    class ThrowingStopMediaRecorder extends FakeMediaRecorder {
      override stop(): void {
        this.stopCall();
        this.state = "inactive";
        throw new Error("stop failed");
      }

      emitStop(): void {
        this.dispatch("stop");
      }
    }
    const firstTrackStop = vi.fn();
    const secondTrackStop = vi.fn();
    const streams = [
      createStream({ stop: firstTrackStop }),
      createStream({ stop: secondTrackStop }),
    ];
    installRecorder(async () => {
      const stream = streams.shift();
      if (!stream) throw new Error("unexpected acquisition");
      return stream;
    }, ThrowingStopMediaRecorder);

    const { result } = renderHook(() => useAudioRecorder());
    await act(async () => {
      await result.current.startRecording();
    });
    const firstRecorder = FakeMediaRecorder
      .instances[0] as ThrowingStopMediaRecorder;

    act(() => result.current.stopRecording());
    expect(firstTrackStop).toHaveBeenCalledOnce();
    expect(result.current.isRecording).toBe(false);

    await act(async () => {
      await result.current.startRecording();
    });
    expect(result.current.isRecording).toBe(true);

    act(() => firstRecorder.emitStop());
    expect(result.current.isRecording).toBe(true);
    expect(secondTrackStop).not.toHaveBeenCalled();
  });

  it("keeps a stale recorder's late dataavailable out of the next session's blob", async () => {
    const streams = [
      createStream({ stop: vi.fn() }),
      createStream({ stop: vi.fn() }),
    ];
    installRecorder(async () => {
      const stream = streams.shift();
      if (!stream) throw new Error("unexpected acquisition");
      return stream;
    });

    const { result } = renderHook(() => useAudioRecorder());
    await act(async () => {
      await result.current.startRecording();
    });
    const firstRecorder = FakeMediaRecorder.instances[0] as FakeMediaRecorder;
    await act(async () => {
      firstRecorder.emitData(new Blob(["r1"]));
      result.current.stopRecording();
    });
    expect(result.current.audioBlob?.size).toBe(6); // "r1" + "-fin"

    await act(async () => {
      await result.current.startRecording();
    });
    const secondRecorder = FakeMediaRecorder.instances[1] as FakeMediaRecorder;
    await act(async () => {
      secondRecorder.emitData(new Blob(["r2!"]));
      // A stale chunk from the retired recorder arrives mid-session.
      firstRecorder.emitData(new Blob(["stale"]));
    });
    await act(async () => {
      result.current.stopRecording();
    });

    expect(result.current.audioBlob?.size).toBe(7); // "r2!" + "-fin" only
  });

  it("preserves the recording when stop is clicked again before the async stop event", async () => {
    const stopTrack = vi.fn();
    installRecorder(async () => createStream({ stop: stopTrack }));

    const { result } = renderHook(() => useAudioRecorder());
    await act(async () => {
      await result.current.startRecording();
    });
    const recorder = FakeMediaRecorder.instances[0] as FakeMediaRecorder;
    await act(async () => {
      recorder.emitData(new Blob(["take"]));
    });

    // Both clicks land inside the sync-inactive window: state is already
    // "inactive" after the first stop() while its events are still queued.
    act(() => {
      result.current.stopRecording();
      expect(recorder.state).toBe("inactive");
      result.current.stopRecording();
    });
    await act(async () => {});

    expect(recorder.stopCall).toHaveBeenCalledOnce();
    expect(result.current.isRecording).toBe(false);
    expect(result.current.audioBlob?.size).toBe(8); // "take" + "-fin"
    expect(stopTrack).toHaveBeenCalledOnce();
  });
});
