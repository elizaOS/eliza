/**
 * Verifies that shell voice errors distinguish an empty recorded utterance
 * from a missing microphone so users receive an accurate recovery action.
 */

import { describe, expect, it } from "vitest";

import {
  describeCaptureFailure,
  isNoSpeechCaptureFailure,
} from "./useShellController";

describe("describeCaptureFailure", () => {
  it("does not report an empty recording as a missing microphone", () => {
    expect(
      describeCaptureFailure(
        new Error("No microphone audio was captured for local ASR"),
      ),
    ).toBe("Didn't catch that — no voice audio was captured. Try again.");
  });

  it("still reports a genuinely missing input device", () => {
    expect(
      describeCaptureFailure(new DOMException("No device", "NotFoundError")),
    ).toBe("No microphone was found. Connect a microphone to use voice.");
  });

  it("treats an empty recording as normal silence", () => {
    expect(
      isNoSpeechCaptureFailure(
        new Error("No microphone audio was captured for local ASR"),
      ),
    ).toBe(true);
  });

  it("treats an empty cloud transcript as normal silence", () => {
    expect(
      isNoSpeechCaptureFailure(
        new Error("Cloud ASR returned an empty transcript"),
      ),
    ).toBe(true);
  });

  it("treats browser and native recognizer silence codes as normal silence", () => {
    expect(
      isNoSpeechCaptureFailure(new Error("SpeechRecognition error: no-speech")),
    ).toBe(true);
    expect(
      isNoSpeechCaptureFailure(new Error("Speech recognition error: no_match")),
    ).toBe(true);
    expect(
      isNoSpeechCaptureFailure(
        new Error("Speech recognition error: speech_timeout"),
      ),
    ).toBe(true);
  });

  it("keeps actionable capture failures visible", () => {
    expect(
      isNoSpeechCaptureFailure(
        new DOMException("Permission denied", "NotAllowedError"),
      ),
    ).toBe(false);
    expect(
      isNoSpeechCaptureFailure(new Error("Cloud ASR 503: unavailable")),
    ).toBe(false);
  });
});
