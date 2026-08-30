/**
 * Verifies that shell voice errors distinguish an empty recorded utterance
 * from a missing microphone so users receive an accurate recovery action.
 */

import { describe, expect, it } from "vitest";

import { describeCaptureFailure } from "./useShellController";

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
});
