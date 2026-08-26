/**
 * Unit tests for the callable browser capabilities required by voice recording.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSupportedMimeType,
  supportsGetUserMedia,
  supportsMediaRecorder,
} from "./audio-utils.ts";

class SupportedMediaRecorder {
  static isTypeSupported(type: string): boolean {
    return type.includes("webm");
  }

  addEventListener(): void {}
  start(): void {}
  stop(): void {}
  pause(): void {}
  resume(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supportsMediaRecorder", () => {
  it("rejects absent and partial MediaRecorder implementations", () => {
    vi.stubGlobal("window", {});
    expect(supportsMediaRecorder()).toBe(false);

    vi.stubGlobal("window", { MediaRecorder: undefined });
    expect(supportsMediaRecorder()).toBe(false);

    vi.stubGlobal("window", { MediaRecorder: {} });
    expect(supportsMediaRecorder()).toBe(false);

    vi.stubGlobal("window", { MediaRecorder: class MediaRecorder {} });
    expect(supportsMediaRecorder()).toBe(false);
  });

  it("accepts a callable recorder with MIME capability detection", () => {
    vi.stubGlobal("window", { MediaRecorder: SupportedMediaRecorder });
    expect(supportsMediaRecorder()).toBe(true);
  });

  it("rejects hostile getters and non-constructible callables", () => {
    const hostileWindow = Object.defineProperty({}, "MediaRecorder", {
      get: () => {
        throw new Error("blocked");
      },
    });
    vi.stubGlobal("window", hostileWindow);
    expect(supportsMediaRecorder()).toBe(false);

    const nonConstructible = Object.assign(() => undefined, {
      isTypeSupported: () => true,
      prototype: SupportedMediaRecorder.prototype,
    });
    vi.stubGlobal("window", { MediaRecorder: nonConstructible });
    expect(supportsMediaRecorder()).toBe(false);
  });
});

describe("supportsGetUserMedia", () => {
  it("rejects absent and non-callable getUserMedia implementations", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    expect(supportsGetUserMedia()).toBe(false);

    vi.stubGlobal("navigator", { mediaDevices: {} });
    expect(supportsGetUserMedia()).toBe(false);

    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: true } });
    expect(supportsGetUserMedia()).toBe(false);
  });

  it("accepts a callable getUserMedia implementation", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn() },
    });
    expect(supportsGetUserMedia()).toBe(true);
  });

  it("rejects a hostile mediaDevices getter", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal(
      "navigator",
      Object.defineProperty({}, "mediaDevices", {
        get: () => {
          throw new Error("blocked");
        },
      }),
    );
    expect(supportsGetUserMedia()).toBe(false);
  });
});

describe("getSupportedMimeType", () => {
  it("returns the first supported MIME type", () => {
    vi.stubGlobal("MediaRecorder", SupportedMediaRecorder);
    vi.stubGlobal("window", { MediaRecorder: SupportedMediaRecorder });
    expect(getSupportedMimeType()).toBe("audio/webm;codecs=opus");
  });

  it("returns an empty string when capability detection is unavailable", () => {
    vi.stubGlobal("MediaRecorder", class MediaRecorder {});
    expect(getSupportedMimeType()).toBe("");
  });

  it("returns an empty string when no MIME type is supported", () => {
    class UnsupportedMediaRecorder extends SupportedMediaRecorder {
      static isTypeSupported(): boolean {
        return false;
      }
    }

    vi.stubGlobal("MediaRecorder", UnsupportedMediaRecorder);
    vi.stubGlobal("window", { MediaRecorder: UnsupportedMediaRecorder });
    expect(getSupportedMimeType()).toBe("");
  });

  it("requires an exact true result and fails closed when MIME probing throws", () => {
    class TruthyMediaRecorder extends SupportedMediaRecorder {
      static isTypeSupported(): boolean {
        return 1 as unknown as boolean;
      }
    }
    vi.stubGlobal("MediaRecorder", TruthyMediaRecorder);
    vi.stubGlobal("window", { MediaRecorder: TruthyMediaRecorder });
    expect(getSupportedMimeType()).toBe("");

    class ThrowingMediaRecorder extends SupportedMediaRecorder {
      static isTypeSupported(): boolean {
        throw new Error("blocked");
      }
    }
    vi.stubGlobal("MediaRecorder", ThrowingMediaRecorder);
    vi.stubGlobal("window", { MediaRecorder: ThrowingMediaRecorder });
    expect(getSupportedMimeType()).toBe("");
  });

  it("can probe the already-selected constructor without rereading browser globals", () => {
    vi.stubGlobal(
      "window",
      Object.defineProperty({}, "MediaRecorder", {
        get: () => {
          throw new Error("global changed");
        },
      }),
    );

    expect(
      getSupportedMimeType(
        SupportedMediaRecorder as unknown as typeof MediaRecorder,
      ),
    ).toBe("audio/webm;codecs=opus");
  });
});
