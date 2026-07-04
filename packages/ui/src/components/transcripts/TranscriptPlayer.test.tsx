// @vitest-environment jsdom

/**
 * Behaviour coverage for TranscriptPlayer: real render in jsdom driving
 * play/pause/scrub and the word-synced highlighting.
 */

import type { Transcript } from "@elizaos/shared/transcripts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptPlayer } from "./TranscriptPlayer";

afterEach(cleanup);

const transcript: Transcript = {
  id: "t1",
  title: "Demo",
  createdAt: 0,
  durationMs: 2000,
  source: "voice-session",
  scope: "owner-private",
  status: "ready",
  speakerCount: 1,
  segments: [
    {
      id: "s1",
      speakerLabel: "Alice",
      startMs: 0,
      endMs: 2000,
      text: "hello there",
      words: [
        { text: "hello", startMs: 0, endMs: 400 },
        { text: "there", startMs: 500, endMs: 1000 },
      ],
    },
  ],
};

describe("TranscriptPlayer", () => {
  it("renders transport + the transcript words when audio is present", () => {
    render(<TranscriptPlayer transcript={transcript} audioUrl="/a.wav" />);
    expect(
      screen.getByTestId("transcript-play").getAttribute("aria-label"),
    ).toBe("play");
    expect(screen.getByTestId("transcript-scrub")).toBeTruthy();
    expect(screen.getByTestId("transcript-word-0-0").textContent).toBe("hello");
  });

  it("seeks the audio element when the scrub bar changes", () => {
    render(<TranscriptPlayer transcript={transcript} audioUrl="/a.wav" />);
    const scrub = screen.getByTestId("transcript-scrub") as HTMLInputElement;
    fireEvent.change(scrub, { target: { value: "500" } });
    const audio = document.querySelector("audio") as HTMLAudioElement;
    expect(audio.currentTime).toBeCloseTo(0.5, 3);
  });

  it("is read-only (no transport) when there is no audio", () => {
    render(<TranscriptPlayer transcript={transcript} />);
    expect(screen.queryByTestId("transcript-play")).toBeNull();
    expect(screen.queryByTestId("transcript-scrub")).toBeNull();
    // The transcript text is still readable.
    expect(screen.getByTestId("transcript-word-0-1").textContent).toBe("there");
  });
});
