// @vitest-environment jsdom

/**
 * Behaviour coverage for TranscriptBody: real render in jsdom asserting the
 * read + word-sync surface for a given transcript and playback position.
 */

import type { Transcript } from "@elizaos/shared/transcripts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptBody } from "./TranscriptBody";

afterEach(cleanup);

const transcript: Transcript = {
  id: "t1",
  title: "Demo",
  createdAt: 0,
  durationMs: 2000,
  source: "voice-session",
  scope: "owner-private",
  status: "ready",
  speakerCount: 2,
  segments: [
    {
      id: "s1",
      speakerLabel: "Alice",
      startMs: 0,
      endMs: 1000,
      text: "hello there",
      words: [
        { text: "hello", startMs: 0, endMs: 400 },
        { text: "there", startMs: 500, endMs: 1000 },
      ],
    },
    {
      id: "s2",
      speakerLabel: "Bob",
      startMs: 1200,
      endMs: 2000,
      text: "hi",
      words: [{ text: "hi", startMs: 1200, endMs: 2000 }],
    },
  ],
};

function activeWords(): string[] {
  return screen
    .getAllByRole("button")
    .filter((b) => b.getAttribute("data-active") === "true")
    .map((b) => b.textContent ?? "");
}

describe("TranscriptBody word-sync highlight", () => {
  it("highlights exactly the word active at the playback time", () => {
    const { rerender } = render(
      <TranscriptBody transcript={transcript} currentTimeMs={0} />,
    );
    expect(activeWords()).toEqual(["hello"]);

    rerender(<TranscriptBody transcript={transcript} currentTimeMs={600} />);
    expect(activeWords()).toEqual(["there"]);

    rerender(<TranscriptBody transcript={transcript} currentTimeMs={1300} />);
    expect(activeWords()).toEqual(["hi"]);
  });

  it("highlights nothing before the first word", () => {
    render(<TranscriptBody transcript={transcript} currentTimeMs={-1} />);
    expect(activeWords()).toEqual([]);
  });

  it("seeks to a word's start on click", () => {
    const onSeekMs = vi.fn();
    render(
      <TranscriptBody
        transcript={transcript}
        currentTimeMs={0}
        onSeekMs={onSeekMs}
      />,
    );
    fireEvent.click(screen.getByTestId("transcript-word-0-1"));
    expect(onSeekMs).toHaveBeenCalledWith(500);
  });

  it("renders speaker labels", () => {
    render(<TranscriptBody transcript={transcript} currentTimeMs={0} />);
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
  });

  it("falls back to a clickable segment when it has no word timings", () => {
    const onSeekMs = vi.fn();
    const noWords: Transcript = {
      ...transcript,
      segments: [
        {
          id: "s1",
          speakerLabel: "Alice",
          startMs: 0,
          endMs: 1000,
          text: "no word timings here",
          words: [],
        },
      ],
    };
    render(
      <TranscriptBody
        transcript={noWords}
        currentTimeMs={500}
        onSeekMs={onSeekMs}
      />,
    );
    const segText = screen.getByTestId("transcript-segment-text-0");
    expect(segText.textContent).toBe("no word timings here");
    fireEvent.click(segText);
    expect(onSeekMs).toHaveBeenCalledWith(0);
  });
});
