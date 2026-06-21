// @vitest-environment jsdom

import type {
  Transcript,
  TranscriptSummary,
} from "@elizaos/shared/transcripts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptsView } from "./TranscriptsView";

afterEach(cleanup);

const summaries: TranscriptSummary[] = [
  {
    id: "t1",
    title: "Standup",
    createdAt: 1_700_000_000_000,
    durationMs: 65_000,
    speakerCount: 2,
    status: "ready",
    preview: "ship the build",
    hasAudio: true,
  },
  {
    id: "t2",
    title: "Note",
    createdAt: 1_700_100_000_000,
    durationMs: 5_000,
    speakerCount: 1,
    status: "processing",
    preview: "",
    hasAudio: false,
  },
];

const selected: Transcript = {
  id: "t1",
  title: "Standup",
  createdAt: 1_700_000_000_000,
  durationMs: 65_000,
  source: "voice-session",
  scope: "owner-private",
  status: "ready",
  speakerCount: 2,
  audioUrl: "/api/media/x.wav",
  segments: [
    {
      id: "s1",
      speakerLabel: "Alice",
      startMs: 0,
      endMs: 2000,
      text: "ship the build",
      words: [{ text: "ship", startMs: 0, endMs: 500 }],
    },
  ],
};

describe("TranscriptsView", () => {
  it("lists recordings and selects on click", () => {
    const onSelect = vi.fn();
    render(
      <TranscriptsView
        transcripts={summaries}
        selectedId={null}
        selected={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByTestId("transcript-row-t1").textContent).toContain(
      "Standup",
    );
    expect(screen.getByTestId("transcript-row-t1").textContent).toContain(
      "2 speakers",
    );
    // processing status surfaces; ready does not add a label.
    expect(screen.getByTestId("transcript-row-t2").textContent).toContain(
      "Processing",
    );
    fireEvent.click(screen.getByTestId("transcript-row-t1"));
    expect(onSelect).toHaveBeenCalledWith("t1");
    // Nothing selected → detail empty state.
    expect(screen.getByTestId("transcripts-detail-empty")).toBeTruthy();
  });

  it("shows the player for the selected transcript", () => {
    render(
      <TranscriptsView
        transcripts={summaries}
        selectedId="t1"
        selected={selected}
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("transcript-row-t1").getAttribute("data-active"),
    ).toBe("true");
    // Player transport + the word render.
    expect(screen.getByTestId("transcript-play")).toBeTruthy();
    expect(screen.getByTestId("transcript-word-0-0").textContent).toBe("ship");
  });

  it("shows an empty hint when there are no recordings", () => {
    render(
      <TranscriptsView
        transcripts={[]}
        selectedId={null}
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("transcripts-empty")).toBeTruthy();
  });
});
