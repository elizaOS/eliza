import type { VoiceCaptureFactoryOptions } from "@elizaos/ui/voice";
import { afterEach, expect, it, vi } from "vitest";
import {
  isKeyboardDictationSessionActive,
  type KeyboardDictationSession,
  startKeyboardDictationSession,
} from "../keyboard-dictation";

vi.mock("@elizaos/ui/bridge", () => ({ getLiveActivityPlugin: () => ({}) }));
vi.mock("@elizaos/ui/voice", () => ({ createVoiceCapture: vi.fn() }));
vi.mock("@elizaos/ui/logger", () => ({ logger: { info: vi.fn() } }));

let current: KeyboardDictationSession | undefined;
afterEach(async () => {
  current?.cancel();
  await Promise.resolve();
});

function fixture() {
  const captures: VoiceCaptureFactoryOptions[] = [];
  const bridge = {
    setDictationState: vi.fn(
      async (_state: {
        status: string;
        sessionId?: string;
        transcript?: string;
      }) => ({ saved: true }),
    ),
    clearDictationState: vi.fn(async () => ({ cleared: true })),
    getDictationState: vi.fn(async () => ({ pending: false })),
  };
  const capture = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    dispose: vi.fn(),
    isActive: () => true,
    getAnalyser: () => null,
  };
  const deps = {
    getBridge: () => bridge,
    getLiveActivity: () => ({}),
    documentRef: () => null,
    createCapture: (options: VoiceCaptureFactoryOptions) => {
      captures.push(options);
      return capture;
    },
  };
  const start = (id: string) => {
    current = startKeyboardDictationSession(
      new URLSearchParams({ session: id }),
      deps,
    );
    return current;
  };
  return { bridge, capture, captures, deps, start };
}

it("orders cancellation after an old publication and before the replacement session", async () => {
  const f = fixture();
  let release!: () => void;
  f.bridge.setDictationState.mockImplementation(async (state) => {
    if (state.status === "ready")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return { saved: true };
  });
  const old = f.start("old");
  await vi.waitFor(() => expect(f.capture.start).toHaveBeenCalledTimes(1));
  f.captures[0].onTranscript({
    text: "old text",
    final: true,
    backend: "browser",
  });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.start("new");
  expect(await old.done).toBe("cancelled");
  expect(f.bridge.clearDictationState).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(f.capture.start).toHaveBeenCalledTimes(2));
  expect(f.bridge.clearDictationState).toHaveBeenCalledTimes(1);
  expect(f.bridge.setDictationState).toHaveBeenLastCalledWith({
    status: "recording",
    sessionId: "new",
  });
  expect(isKeyboardDictationSessionActive()).toBe(true);
});

it("does not fabricate success from a rejected native save receipt", async () => {
  const f = fixture();
  f.bridge.setDictationState.mockResolvedValue({ saved: false });
  expect(await f.start("failed").done).toBe("error");
  expect(f.capture.start).not.toHaveBeenCalled();
});

it("retains final segments arriving while a handoff write is pending", async () => {
  const f = fixture();
  let release!: () => void;
  let readyWrites = 0;
  f.bridge.setDictationState.mockImplementation(async (state) => {
    if (state.status === "ready" && ++readyWrites === 1) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return { saved: true };
  });
  const session = f.start("whole");
  await vi.waitFor(() => expect(f.capture.start).toHaveBeenCalled());
  f.captures[0].onTranscript({
    text: "first",
    final: true,
    backend: "browser",
  });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  f.captures[0].onTranscript({
    text: "second",
    final: true,
    backend: "browser",
  });
  release();
  expect(await session.done).toBe("ready");
  expect(f.bridge.setDictationState).toHaveBeenLastCalledWith({
    status: "ready",
    sessionId: "whole",
    transcript: "first second",
  });
});

it("settles capture construction failures as errors", async () => {
  const f = fixture();
  current = startKeyboardDictationSession(new URLSearchParams(), {
    ...f.deps,
    createCapture: () => {
      throw new Error("capture unavailable");
    },
  });
  expect(await current.done).toBe("error");
  expect(isKeyboardDictationSessionActive()).toBe(false);
});

it("does not start recording after an immediate finish", async () => {
  const f = fixture();
  const session = f.start("finish-before-start");
  session.finish();
  session.finish();
  expect(await session.done).toBe("error");
  expect(f.capture.start).not.toHaveBeenCalled();
  expect(f.capture.stop).toHaveBeenCalledTimes(1);
});

it("settles cancellation even when capture disposal throws", async () => {
  const f = fixture();
  f.capture.dispose.mockImplementation(() => {
    throw new Error("dispose failed");
  });
  const session = f.start("dispose-failure");
  session.cancel();
  expect(await session.done).toBe("cancelled");
  expect(isKeyboardDictationSessionActive()).toBe(false);
});
