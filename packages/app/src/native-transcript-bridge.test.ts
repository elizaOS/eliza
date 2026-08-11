// @vitest-environment jsdom

/**
 * Actual app-entry bridge coverage: typed renderer events make a Capacitor or
 * Electrobun round-trip, validated host parity becomes the visible snapshot,
 * and malformed host state leaves the web reducer intact with an observed log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  native: false,
  name: "web",
  electrobun: false,
  publishStream: vi.fn(),
  desktopRequest: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => platform.name,
    isNativePlatform: () => platform.native,
    registerPlugin: () => ({ publishStream: platform.publishStream }),
  },
}));

vi.mock("@elizaos/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/logger")>();
  return {
    ...actual,
    logger: { ...actual.logger, error: platform.loggerError },
  };
});

vi.mock("@elizaos/ui/bridge", () => ({
  isElectrobunRuntime: () => platform.electrobun,
  invokeDesktopBridgeRequest: (options: unknown) =>
    platform.desktopRequest(options),
}));

import {
  getNativeTranscriptSnapshot,
  publishNativeTranscriptEvent,
  resetNativeTranscriptSequenceForTests,
} from "@elizaos/ui/native-transcript";
import {
  installNativeTranscriptPlatformBridge,
  resetNativeTranscriptPlatformBridgeForTests,
} from "./native-transcript-bridge";

function matchingHostResponse() {
  return {
    view: structuredClone(getNativeTranscriptSnapshot().view),
    rejectedIndexes: [],
  };
}

describe("native transcript product bridge", () => {
  beforeEach(() => {
    resetNativeTranscriptPlatformBridgeForTests();
    resetNativeTranscriptSequenceForTests();
    platform.native = false;
    platform.name = "web";
    platform.electrobun = false;
    platform.publishStream.mockReset();
    platform.desktopRequest.mockReset();
    platform.loggerError.mockReset();
    platform.publishStream.mockImplementation(async () =>
      matchingHostResponse(),
    );
    platform.desktopRequest.mockImplementation(async () =>
      matchingHostResponse(),
    );
  });

  afterEach(resetNativeTranscriptPlatformBridgeForTests);

  it.each(["ios", "android"] as const)(
    "makes %s host parity the product snapshot",
    async (nativePlatform) => {
      platform.native = true;
      platform.name = nativePlatform;
      installNativeTranscriptPlatformBridge();
      publishNativeTranscriptEvent({
        type: "stt.final",
        turnId: "turn-1",
        text: "native voice",
      });

      await vi.waitFor(() => {
        expect(getNativeTranscriptSnapshot().source).toBe(nativePlatform);
      });
      expect(platform.publishStream).toHaveBeenCalledTimes(1);
      expect(platform.loggerError).not.toHaveBeenCalled();
    },
  );

  it("makes Electrobun host parity the desktop product snapshot", async () => {
    platform.electrobun = true;
    installNativeTranscriptPlatformBridge();
    publishNativeTranscriptEvent({
      type: "error",
      code: "permission-denied",
      retryable: false,
      message: "Microphone permission denied",
    });

    await vi.waitFor(() => {
      expect(getNativeTranscriptSnapshot().source).toBe("desktop");
    });
    expect(platform.desktopRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "nativeTranscriptPublishStream",
      }),
    );
  });

  it("uses the same renderer projection directly on web", async () => {
    installNativeTranscriptPlatformBridge();
    publishNativeTranscriptEvent({
      type: "stt.partial",
      turnId: "turn-web",
      text: "web voice",
    });
    await Promise.resolve();

    expect(getNativeTranscriptSnapshot().source).toBe("web");
    expect(platform.publishStream).not.toHaveBeenCalled();
    expect(platform.desktopRequest).not.toHaveBeenCalled();
  });

  it("observes malformed host output and preserves the renderer projection", async () => {
    platform.native = true;
    platform.name = "ios";
    platform.publishStream.mockResolvedValue({
      view: { items: [], speaking: null, connection: "unknown", lastSeq: 1 },
      rejectedIndexes: [],
    });
    installNativeTranscriptPlatformBridge();
    publishNativeTranscriptEvent({
      type: "stt.final",
      turnId: "turn-1",
      text: "keep me",
    });

    await vi.waitFor(() => expect(platform.loggerError).toHaveBeenCalled());
    expect(getNativeTranscriptSnapshot()).toMatchObject({
      source: "web",
      view: { items: [{ kind: "user", text: "keep me" }] },
    });
  });
});
