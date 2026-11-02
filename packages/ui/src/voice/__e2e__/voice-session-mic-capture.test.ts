import { expect, test, vi } from "vitest";
import { FakeMicAudioContext } from "../__tests__/voice-session-fakes";
import {
  startVoiceMicCapture,
  VoiceMicReleaseError,
} from "../voice-session-mic-capture";

/** As a real track: stop() ends it synchronously, and its state reports that. */
function liveTrack() {
  const track = {
    readyState: "live",
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
  };
  return track;
}

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
  const track = liveTrack();
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
  const track = liveTrack();
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

class FaultyContext extends LifecycleContext {
  constructor(readonly faulty: "source" | "processor" | "listener" | null) {
    super();
  }
  createMediaStreamSource() {
    const node = super.createMediaStreamSource();
    if (this.faulty === "source")
      node.disconnect = () => {
        throw new Error("source disconnect refused");
      };
    return node;
  }
  createScriptProcessor() {
    const node = super.createScriptProcessor();
    if (this.faulty === "processor")
      node.disconnect = () => {
        throw new Error("processor disconnect refused");
      };
    return node;
  }
  removeEventListener(type: "statechange", listener: () => void) {
    if (this.faulty === "listener")
      throw new Error("listener removal refused");
    super.removeEventListener(type, listener);
  }
}
const visibility = {
  addListener() {},
  removeListener() {},
  isHidden: () => false,
};
function streamOf(...tracks: Array<{ readyState: string; stop(): void }>) {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  } as unknown as MediaStream;
}

test.each([
  ["the source disconnect", "source"],
  ["the processor disconnect", "processor"],
  ["the context listener removal", "listener"],
] as const)("a throwing %s still ends a live track", async (_name, faulty) => {
  const context = new FaultyContext(faulty);
  const track = liveTrack();
  const capture = await startVoiceMicCapture({
    onFrame: vi.fn(),
    getUserMedia: async () => streamOf(track),
    createAudioContext: () => context,
    visibility,
  });
  expect(track.readyState).toBe("live");
  await capture.stop();
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(track.readyState).toBe("ended");
  expect(context.closed).toBe(true);
  expect(capture.active).toBe(false);
});

test("a throwing visibility listener removal still ends a live track", async () => {
  const track = liveTrack();
  const capture = await startVoiceMicCapture({
    onFrame: vi.fn(),
    getUserMedia: async () => streamOf(track),
    createAudioContext: () => new FakeMicAudioContext(),
    visibility: {
      ...visibility,
      removeListener() {
        throw new Error("visibility removal refused");
      },
    },
  });
  await capture.stop();
  expect(track.readyState).toBe("ended");
});

test("a normal stop confirms once, and a repeat asks nothing more", async () => {
  const context = new FakeMicAudioContext();
  const track = liveTrack();
  const capture = await startVoiceMicCapture({
    onFrame: vi.fn(),
    getUserMedia: async () => streamOf(track),
    createAudioContext: () => context,
    visibility,
  });
  await Promise.all([capture.stop(), capture.stop()]);
  await capture.stop();
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(track.readyState).toBe("ended");
});

test("a track that refuses leaves its siblings stopped, rejects, and confirms only on its own retry", async () => {
  const refusing = liveTrack();
  const stopRefusing = refusing.stop.getMockImplementation();
  refusing.stop.mockImplementation(() => {
    throw new Error("track stop refused");
  });
  const sibling = liveTrack();
  const capture = await startVoiceMicCapture({
    onFrame: vi.fn(),
    getUserMedia: async () => streamOf(refusing, sibling),
    createAudioContext: () => new FakeMicAudioContext(),
    visibility,
  });
  const failure = await capture.stop().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(VoiceMicReleaseError);
  expect(failure).toMatchObject({ code: "release_unconfirmed" });
  expect(sibling.readyState).toBe("ended");
  expect(refusing.readyState).toBe("live");
  await expect(capture.stop()).rejects.toBeInstanceOf(VoiceMicReleaseError);
  await expect(
    (failure as VoiceMicReleaseError).retryRelease(),
  ).rejects.toBeInstanceOf(VoiceMicReleaseError);
  refusing.stop.mockImplementation(stopRefusing as () => void);
  await (failure as VoiceMicReleaseError).retryRelease();
  expect(refusing.readyState).toBe("ended");
  await capture.stop();
});

test("a stop that leaves a track live is no proof of release", async () => {
  const track = { readyState: "live", stop: vi.fn() };
  const capture = await startVoiceMicCapture({
    onFrame: vi.fn(),
    getUserMedia: async () => streamOf(track),
    createAudioContext: () => new FakeMicAudioContext(),
    visibility,
  });
  await expect(capture.stop()).rejects.toBeInstanceOf(VoiceMicReleaseError);
  track.readyState = "ended";
  await capture.stop();
});

test("an unawaited stop that is refused stays quiet until the owner's stop reports it", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    const track = { readyState: "live", stop: vi.fn() };
    const controller = new AbortController();
    const capture = await startVoiceMicCapture({
      onFrame: vi.fn(),
      getUserMedia: async () => streamOf(track),
      createAudioContext: () => new FakeMicAudioContext(),
      signal: controller.signal,
      visibility,
    });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).not.toHaveBeenCalled();
    await expect(capture.stop()).rejects.toBeInstanceOf(VoiceMicReleaseError);
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});

test("a context close that never settles leaves the verdict to the tracks", async () => {
  class HungClose extends FakeMicAudioContext {
    close(): Promise<void> {
      return new Promise(() => {});
    }
  }
  const track = liveTrack();
  const capture = await startVoiceMicCapture({
    onFrame: vi.fn(),
    getUserMedia: async () => streamOf(track),
    createAudioContext: () => new HungClose(),
    visibility,
  });
  await capture.stop();
  expect(track.readyState).toBe("ended");
});

test("a capture cancelled while the device opens rejects until its track has ended", async () => {
  const track = { readyState: "live", stop: vi.fn() };
  const controller = new AbortController();
  const failure = await startVoiceMicCapture({
    onFrame: vi.fn(),
    // Cancelled once the stream is in hand, before the capture goes on with it.
    getUserMedia: () => {
      const media = Promise.resolve(streamOf(track));
      void media.then(() => {}).then(() => controller.abort());
      return media;
    },
    createAudioContext: () => new FakeMicAudioContext(),
    signal: controller.signal,
    visibility,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(VoiceMicReleaseError);
  await expect(
    (failure as VoiceMicReleaseError).retryRelease(),
  ).rejects.toBeInstanceOf(VoiceMicReleaseError);
  track.readyState = "ended";
  await (failure as VoiceMicReleaseError).retryRelease();
});

test("a failed startup ends its track past a throwing disconnect", async () => {
  class BrokenPipeline extends FaultyContext {
    createScriptProcessor(): never {
      throw new Error("no processor");
    }
  }
  const context = new BrokenPipeline("source");
  const track = liveTrack();
  await expect(
    startVoiceMicCapture({
      onFrame: vi.fn(),
      getUserMedia: async () => streamOf(track),
      createAudioContext: () => context,
      visibility,
    }),
  ).rejects.toMatchObject({ code: "start_failed" });
  expect(track.readyState).toBe("ended");
  expect(context.closed).toBe(true);
});

test("a failed startup whose track refuses hands back the release to retry", async () => {
  class BrokenPipeline extends FakeMicAudioContext {
    createScriptProcessor(): never {
      throw new Error("no processor");
    }
  }
  const track = { readyState: "live", stop: vi.fn() };
  const failure = await startVoiceMicCapture({
    onFrame: vi.fn(),
    getUserMedia: async () => streamOf(track),
    createAudioContext: () => new BrokenPipeline(),
    visibility,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(VoiceMicReleaseError);
  track.readyState = "ended";
  await (failure as VoiceMicReleaseError).retryRelease();
});
