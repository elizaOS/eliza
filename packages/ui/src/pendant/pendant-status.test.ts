/**
 * Shared pendant status labels stay identical across transcript and settings UI.
 */

import { describe, expect, it } from "vitest";
import {
  isPendantLiveStatus,
  pendantConnectStepLabel,
  pendantStatusLabel,
} from "./pendant-status";

describe("pendant status vocabulary", () => {
  it("keeps reconnecting labelled but outside live-state checks", () => {
    expect(pendantStatusLabel("reconnecting")).toBe("Reconnecting...");
    expect(isPendantLiveStatus("reconnecting")).toBe(false);
  });

  it("labels every status distinctly — no status falls through unnamed", () => {
    expect(pendantStatusLabel("unsupported")).toBe(
      "Not supported in this browser",
    );
    expect(pendantStatusLabel("idle")).toBe("Not connected");
    expect(pendantStatusLabel("requesting")).toBe("Choose a device...");
    expect(pendantStatusLabel("connecting")).toBe("Connecting...");
    expect(pendantStatusLabel("connected")).toBe("Connected");
    expect(pendantStatusLabel("listening")).toBe("Listening");
    expect(pendantStatusLabel("hearing")).toBe("Hearing you...");
    expect(pendantStatusLabel("transcribing")).toBe("Transcribing...");
    expect(pendantStatusLabel("paused")).toBe("Paused");
    expect(pendantStatusLabel("error")).toBe("Connection error");
  });

  it("shares human connect step labels", () => {
    expect(pendantConnectStepLabel("start-notifications")).toBe(
      "subscribing to audio",
    );
    expect(pendantConnectStepLabel("idle")).toBeNull();
  });

  it("labels every in-flight connect step and hides the terminal ones", () => {
    expect(pendantConnectStepLabel("gatt-connect")).toBe("linking GATT");
    expect(pendantConnectStepLabel("audio-service")).toBe(
      "finding audio service",
    );
    expect(pendantConnectStepLabel("codec-read")).toBe("reading codec");
    expect(pendantConnectStepLabel("decoder-init")).toBe("loading decoder");
    expect(pendantConnectStepLabel("audio-char")).toBe("finding audio channel");
    expect(pendantConnectStepLabel("battery")).toBe("reading battery");
    expect(pendantConnectStepLabel("done")).toBeNull();
  });

  it("treats every post-connect state as live and every pre-connect state as not", () => {
    for (const live of [
      "connected",
      "listening",
      "hearing",
      "transcribing",
      "paused",
    ] as const) {
      expect(isPendantLiveStatus(live)).toBe(true);
    }
    for (const notLive of [
      "unsupported",
      "idle",
      "requesting",
      "connecting",
      "error",
    ] as const) {
      expect(isPendantLiveStatus(notLive)).toBe(false);
    }
  });
});
