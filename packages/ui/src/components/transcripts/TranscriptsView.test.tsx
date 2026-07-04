// @vitest-environment jsdom

/**
 * Behaviour coverage for TranscriptsView: real render in jsdom asserting the
 * recordings list + player pairing and meeting-aware summary handling.
 */

import type {
  Transcript,
  TranscriptSummary,
} from "@elizaos/shared/transcripts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type MeetingAwareTranscriptSummary,
  TranscriptsView,
} from "./TranscriptsView";

afterEach(cleanup);

const summaries: TranscriptSummary[] = [
  {
    id: "t1",
    title: "Standup",
    createdAt: 1_700_000_000_000,
    durationMs: 65_000,
    speakerCount: 2,
    status: "ready",
    source: "voice-session",
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
    source: "voice-session",
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

  // The server-computed list-row projection (summarizeTranscript): the badge
  // platform + the participant COUNT are already on the summary; the roster
  // names live only on the full transcript record (detail pane).
  const meetingSummary: MeetingAwareTranscriptSummary = {
    id: "m1",
    title: "Weekly sync",
    createdAt: 1_700_200_000_000,
    durationMs: 120_000,
    speakerCount: 3,
    status: "recording",
    preview: "",
    hasAudio: false,
    source: "meeting",
    meeting: {
      platform: "google_meet",
      participantCount: 2,
    },
  };

  /** The full meeting record the detail pane renders (roster names + platform). */
  const meetingDetailMetadata = {
    platform: "google_meet",
    participants: [
      { id: "1", displayName: "Alice" },
      { id: "2", displayName: "Bob" },
    ],
  };

  it("renders platform badge, participant count, and LIVE on a live meeting row", () => {
    render(
      <TranscriptsView
        transcripts={[meetingSummary]}
        selectedId={null}
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("transcript-platform-m1").textContent).toBe(
      "Google Meet",
    );
    expect(screen.getByTestId("transcript-participants-m1").textContent).toBe(
      "2 participants",
    );
    expect(screen.getByTestId("transcript-live-m1").textContent).toContain(
      "LIVE",
    );
    // no "Recording" status label when the LIVE dot already says so
    expect(screen.getByTestId("transcript-row-m1").textContent).not.toContain(
      "Recording",
    );
  });

  it("omits meeting affordances on an archived meeting row", () => {
    render(
      <TranscriptsView
        transcripts={[{ ...meetingSummary, status: "ready" }]}
        selectedId={null}
        selected={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("transcript-live-m1")).toBeNull();
    expect(screen.getByTestId("transcript-platform-m1")).toBeTruthy();
  });

  it("shows meeting metadata + the player on an archived meeting detail", () => {
    const archivedMeeting: Transcript = {
      ...selected,
      id: "m1",
      title: "Weekly sync",
      source: "meeting",
      status: "ready",
      metadata: meetingDetailMetadata,
    };
    render(
      <TranscriptsView
        transcripts={[{ ...meetingSummary, status: "ready" }]}
        selectedId="m1"
        selected={archivedMeeting}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("meeting-detail-platform").textContent).toBe(
      "Google Meet",
    );
    expect(screen.getByTestId("meeting-detail-participants").textContent).toBe(
      "Alice, Bob",
    );
    // archived meeting with audio still uses the standard player
    expect(screen.getByTestId("transcript-play")).toBeTruthy();
    expect(screen.queryByTestId("live-meeting-pane")).toBeNull();
  });

  it("renders the join bar and forwards a join request", () => {
    const onJoinMeeting = vi.fn();
    render(
      <TranscriptsView
        transcripts={[]}
        selectedId={null}
        selected={null}
        onSelect={vi.fn()}
        activeMeetings={[]}
        onJoinMeeting={onJoinMeeting}
        onStopMeeting={vi.fn()}
      />,
    );
    // join bar is present even on the empty state
    fireEvent.change(screen.getByTestId("meeting-url-input"), {
      target: { value: "https://meet.google.com/abc-defg-hij" },
    });
    fireEvent.submit(screen.getByTestId("meeting-join-form"));
    expect(onJoinMeeting).toHaveBeenCalledWith({
      platform: "google_meet",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
    });
  });
});
