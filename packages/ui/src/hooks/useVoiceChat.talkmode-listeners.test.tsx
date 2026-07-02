// @vitest-environment jsdom

import type { PluginListenerHandle } from "@capacitor/core";
import { Capacitor } from "@capacitor/core";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTalkModePlugin } from "../bridge/native-plugins";
import { useVoiceChat } from "./useVoiceChat";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const talkModeMock = vi.hoisted(() => ({
  addListener: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../bridge/native-plugins", () => ({
  getTalkModePlugin: vi.fn(() => talkModeMock),
}));

describe("useVoiceChat TalkMode listener lifecycle", () => {
  let isNativePlatformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    isNativePlatformSpy = vi
      .spyOn(Capacitor, "isNativePlatform")
      .mockReturnValue(true);
    talkModeMock.checkPermissions.mockResolvedValue({
      microphone: "granted",
      speechRecognition: "granted",
    });
    talkModeMock.requestPermissions.mockResolvedValue({
      microphone: "granted",
      speechRecognition: "granted",
    });
    talkModeMock.start.mockResolvedValue({ started: true });
    talkModeMock.stop.mockResolvedValue(undefined);

    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speaking: false,
        pending: false,
        cancel: vi.fn(),
        getVoices: vi.fn(() => []),
        speak: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
    isNativePlatformSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("coalesces concurrent TalkMode listener setup into one removable handle set", async () => {
    const listenerAdds = [
      deferred<PluginListenerHandle>(),
      deferred<PluginListenerHandle>(),
      deferred<PluginListenerHandle>(),
    ];
    const removeFns = [
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue(undefined),
    ];
    talkModeMock.addListener.mockImplementation(() => {
      const next = listenerAdds[talkModeMock.addListener.mock.calls.length - 1];
      if (!next) throw new Error("unexpected listener registration");
      return next.promise;
    });
    const { result, unmount } = renderHook(() =>
      useVoiceChat({
        onTranscript: vi.fn(),
      }),
    );

    const firstStart = result.current.startListening("push-to-talk");
    const secondStart = result.current.startListening("push-to-talk");

    await waitFor(() =>
      expect(talkModeMock.addListener).toHaveBeenCalledTimes(1),
    );
    listenerAdds[0]?.resolve({ remove: removeFns[0] });
    await waitFor(() =>
      expect(talkModeMock.addListener).toHaveBeenCalledTimes(2),
    );
    listenerAdds[1]?.resolve({ remove: removeFns[1] });
    await waitFor(() =>
      expect(talkModeMock.addListener).toHaveBeenCalledTimes(3),
    );
    listenerAdds[2]?.resolve({ remove: removeFns[2] });

    await act(async () => {
      await Promise.all([firstStart, secondStart]);
    });

    expect(getTalkModePlugin).toHaveBeenCalled();
    expect(talkModeMock.addListener).toHaveBeenCalledTimes(3);
    expect(
      talkModeMock.addListener.mock.calls.map(([eventName]) => eventName),
    ).toEqual(["transcript", "error", "stateChange"]);

    unmount();

    await waitFor(() => expect(removeFns[0]).toHaveBeenCalledTimes(1));
    expect(removeFns[1]).toHaveBeenCalledTimes(1);
    expect(removeFns[2]).toHaveBeenCalledTimes(1);
  });
});
