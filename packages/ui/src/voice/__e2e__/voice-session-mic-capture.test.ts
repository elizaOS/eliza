import { expect, test, vi } from "vitest";
import { FakeMicAudioContext } from "../__tests__/voice-session-fakes";
import { startVoiceMicCapture } from "../voice-session-mic-capture";

class LifecycleContext extends FakeMicAudioContext {
  readonly listeners = new Set<() => void>();
  addEventListener(_type: "statechange", listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "statechange", listener: () => void) {
    this.listeners.delete(listener);
  }
  change(state: AudioContextState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

test("external context closure retires capture once and removes lifecycle listeners", async () => {
  const context = new LifecycleContext();
  const track = { readyState: "live", stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const onError = vi.fn();
  const capture = await startVoiceMicCapture({
    onFrame: vi.fn(),
    onError,
    getUserMedia: async () => stream,
    createAudioContext: () => context,
    visibility: {
      addListener() {},
      removeListener() {},
      isHidden: () => false,
    },
  });
  expect(capture.active).toBe(true);
  context.change("suspended");
  expect(capture.active).toBe(false);
  context.change("running");
  expect(capture.active).toBe(true);
  context.change("closed");
  await capture.stop();
  expect(capture.active).toBe(false);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(context.listeners.size).toBe(0);
});

function liveStream() {
  const track = { readyState: "live", stop: vi.fn() };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  return { track, stream };
}

test("a context that will not run fails startup instead of capturing silence", async () => {
  class DeniedContext extends FakeMicAudioContext {
    async resume() {
      throw new Error("resume denied");
    }
  }
  const context = new DeniedContext();
  const { track, stream } = liveStream();
  await expect(
    startVoiceMicCapture({
      onFrame: vi.fn(),
      getUserMedia: async () => stream,
      createAudioContext: () => context,
    }),
  ).rejects.toThrow();
  expect(track.stop).toHaveBeenCalled();
});

test("a visibility resume that leaves the graph stopped releases the microphone", async () => {
  const context = new FakeMicAudioContext();
  const { track, stream } = liveStream();
  let hidden = false;
  let onVisibility = () => {};
  const onError = vi.fn();
  const onResume = vi.fn();
  const capture = await startVoiceMicCapture({
    onFrame: vi.fn(),
    onError,
    onResume,
    getUserMedia: async () => stream,
    createAudioContext: () => context,
    visibility: {
      addListener(listener) {
        onVisibility = listener;
      },
      removeListener() {},
      isHidden: () => hidden,
    },
  });
  hidden = true;
  onVisibility();
  context.resume = async () => {
    context.state = "suspended";
  };
  hidden = false;
  onVisibility();
  await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(onResume).not.toHaveBeenCalled();
  expect(capture.active).toBe(false);
  expect(track.stop).toHaveBeenCalled();
});
