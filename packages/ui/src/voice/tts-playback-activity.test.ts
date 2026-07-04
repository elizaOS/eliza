/** Renderer TTS echo-gate signal (#12256 layer 1) — pure timing state. */

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetTtsPlaybackActivityForTest,
  DEFAULT_POST_TTS_COOLDOWN_MS,
  isTtsEchoGateActive,
  markTtsPlaybackEnded,
  markTtsPlaybackStarted,
} from "./tts-playback-activity";

afterEach(() => __resetTtsPlaybackActivityForTest());

describe("tts-playback-activity", () => {
  it("gate is off with no playback", () => {
    expect(isTtsEchoGateActive(1000)).toBe(false);
  });

  it("gate is active while any playback session runs", () => {
    markTtsPlaybackStarted();
    expect(isTtsEchoGateActive(1000)).toBe(true);
    // A second overlapping session keeps it active until both end.
    markTtsPlaybackStarted();
    markTtsPlaybackEnded(1000);
    expect(isTtsEchoGateActive(1000)).toBe(true);
    markTtsPlaybackEnded(1000);
    expect(isTtsEchoGateActive(1000)).toBe(true); // still inside cooldown
  });

  it("stays active through the cooldown window, then clears", () => {
    markTtsPlaybackStarted();
    markTtsPlaybackEnded(5000);
    expect(isTtsEchoGateActive(5000 + DEFAULT_POST_TTS_COOLDOWN_MS)).toBe(true);
    expect(
      isTtsEchoGateActive(5000 + DEFAULT_POST_TTS_COOLDOWN_MS + 1),
    ).toBe(false);
  });

  it("honors a custom cooldown", () => {
    markTtsPlaybackStarted();
    markTtsPlaybackEnded(0);
    expect(isTtsEchoGateActive(400, 500)).toBe(true);
    expect(isTtsEchoGateActive(600, 500)).toBe(false);
  });
});
