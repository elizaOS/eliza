import { describe, expect, it } from "vitest";
import {
  classifyPlaybackTransportIntent,
  isPlaybackTransportControlOnlyMessage,
} from "./playbackTransportIntent.js";

describe("isPlaybackTransportControlOnlyMessage", () => {
  it("detects plain pause", () => {
    expect(isPlaybackTransportControlOnlyMessage("pause")).toBe(true);
    expect(isPlaybackTransportControlOnlyMessage("Pause it.")).toBe(true);
    expect(isPlaybackTransportControlOnlyMessage("pause the music")).toBe(true);
  });

  it("detects polite / question forms", () => {
    expect(isPlaybackTransportControlOnlyMessage("can you pause?")).toBe(true);
    expect(
      isPlaybackTransportControlOnlyMessage("please pause the music"),
    ).toBe(true);
  });

  it("detects skip and stop phrasing", () => {
    expect(isPlaybackTransportControlOnlyMessage("skip")).toBe(true);
    expect(isPlaybackTransportControlOnlyMessage("next track")).toBe(true);
    expect(isPlaybackTransportControlOnlyMessage("stop the music")).toBe(true);
  });

  it("returns false when a URL or play intent is present", () => {
    expect(
      isPlaybackTransportControlOnlyMessage("pause https://youtu.be/x"),
    ).toBe(false);
    expect(
      isPlaybackTransportControlOnlyMessage("play bohemian rhapsody"),
    ).toBe(false);
  });

  it("returns false for empty", () => {
    expect(isPlaybackTransportControlOnlyMessage("")).toBe(false);
    expect(isPlaybackTransportControlOnlyMessage("   ")).toBe(false);
  });

  it("detects loose paraphrases (single intent)", () => {
    expect(
      isPlaybackTransportControlOnlyMessage("could you pause it for a sec"),
    ).toBe(true);
  });
});

describe("classifyPlaybackTransportIntent", () => {
  it("maps user text to transport kind", () => {
    expect(classifyPlaybackTransportIntent("pause")).toBe("pause");
    expect(classifyPlaybackTransportIntent("resume the music")).toBe("resume");
    expect(classifyPlaybackTransportIntent("skip this")).toBe("skip");
    expect(classifyPlaybackTransportIntent("stop the music")).toBe("stop");
    expect(classifyPlaybackTransportIntent("play a song")).toBe(null);
  });
});
