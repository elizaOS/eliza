// @vitest-environment jsdom

/**
 * Fallback-slop three-state coverage for TranscriptsPage (#12784 /
 * packages/ui three-state rule).
 *
 * BEFORE: `refresh()` used `Promise.allSettled([listTranscripts, listMeetings])`
 * but only re-threw on a rejected transcripts list. A rejected `listMeetings`
 * (active-meetings poll) was fully swallowed — the join bar then rendered the
 * healthy "no active meetings" state even while a bot could be live in a broken
 * / unreachable backend. Transport/5xx failure collapsed into a designed-empty
 * state with no signal.
 *
 * AFTER: a rejected meetings fetch surfaces a `role="alert"` banner in the join
 * bar, the last-known active sessions are NOT blanked, the transcripts list
 * still renders from its own (successful) half, and a subsequent successful
 * refresh clears the banner.
 */

import type { MeetingSession } from "@elizaos/shared";
import type { TranscriptSummary } from "@elizaos/shared/transcripts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  listTranscripts: vi.fn(),
  listMeetings: vi.fn(),
  getTranscript: vi.fn(),
  requestMeetingBot: vi.fn(),
  stopMeeting: vi.fn(),
  onWsEvent: vi.fn(
    (_type: string, _handler: (data: unknown) => void): (() => void) =>
      () => {},
  ),
}));

// parseMeetingStatusEvent is driven per-test: default null (ignore stray
// events), but the recovery test swaps in a valid non-terminal event so the
// ws handler runs its refresh() path.
const parseMeetingStatusEventMock = vi.hoisted(() =>
  vi.fn((_data: unknown) => null as unknown),
);

vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../api/client-meetings", () => ({
  parseMeetingStatusEvent: parseMeetingStatusEventMock,
}));
vi.mock("../shared/ViewHeader", () => ({
  ViewHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

import { TranscriptsPage } from "./TranscriptsPage";

const transcript: TranscriptSummary = {
  id: "t1",
  title: "Standup",
  createdAt: 1_700_000_000_000,
  durationMs: 65_000,
  speakerCount: 2,
  status: "ready",
  source: "voice-session",
  preview: "ship the build",
  hasAudio: true,
};

const activeSession = {
  id: "m1",
  status: "recording",
  transcriptId: "t9",
  meetingUrl: "https://meet.example.com/abc",
  platform: "meet",
  createdAt: 1_700_000_000_000,
} as unknown as MeetingSession;

describe("TranscriptsPage active-meetings fetch failure (three-state)", () => {
  beforeEach(() => {
    clientMock.listTranscripts.mockReset();
    clientMock.listMeetings.mockReset();
    clientMock.onWsEvent.mockReset();
    clientMock.onWsEvent.mockReturnValue(() => {});
    parseMeetingStatusEventMock.mockReset();
    parseMeetingStatusEventMock.mockReturnValue(null);
  });

  afterEach(cleanup);

  it("surfaces a failed active-meetings fetch instead of a healthy empty strip, while still rendering transcripts", async () => {
    clientMock.listTranscripts.mockResolvedValue({ transcripts: [transcript] });
    clientMock.listMeetings.mockRejectedValue(
      new Error("meetings backend unreachable"),
    );

    render(<TranscriptsPage />);

    // The meetings-fetch failure is surfaced (not swallowed into empty state).
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "meetings backend unreachable",
      );
    });

    // The transcripts list still renders from its own successful half.
    expect(screen.getByText("Standup")).toBeTruthy();
    // No fabricated active-meetings strip.
    expect(screen.queryByTestId("active-meetings")).toBeNull();
  });

  it("falls back to a generic message when the meetings rejection is not an Error", async () => {
    clientMock.listTranscripts.mockResolvedValue({ transcripts: [transcript] });
    clientMock.listMeetings.mockRejectedValue("boom");

    render(<TranscriptsPage />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Failed to load active meetings",
      );
    });
  });

  it("does not show a meetings error and renders the active strip when the fetch succeeds", async () => {
    clientMock.listTranscripts.mockResolvedValue({ transcripts: [transcript] });
    clientMock.listMeetings.mockResolvedValue({ sessions: [activeSession] });

    render(<TranscriptsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("active-meetings")).toBeTruthy();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears a stale meetings-error banner once a later refresh succeeds", async () => {
    clientMock.listTranscripts.mockResolvedValue({ transcripts: [transcript] });
    // Capture the ws handler so we can drive a refresh() from a status event.
    let wsHandler: ((data: unknown) => void) | undefined;
    clientMock.onWsEvent.mockImplementation(
      (_type: string, handler: (data: unknown) => void) => {
        wsHandler = handler;
        return () => {};
      },
    );

    // A valid, non-terminal ws event so the handler reaches refresh() (a
    // terminal status would also try to reload the open transcript).
    parseMeetingStatusEventMock.mockReturnValue({
      type: "meeting-status",
      session: { id: "m1", status: "recording" } as unknown as MeetingSession,
    });

    // First refresh: meetings fetch fails.
    clientMock.listMeetings.mockRejectedValueOnce(new Error("transient 503"));
    // Subsequent refreshes: meetings fetch recovers.
    clientMock.listMeetings.mockResolvedValue({ sessions: [] });

    render(<TranscriptsPage />);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("transient 503");
    });
    expect(wsHandler).toBeTypeOf("function");

    // A meeting-status ws event triggers refresh() (parse returns null, so no
    // detail reload — just the list refresh path). Wrap so the async state
    // flush from the resolved refresh is applied deterministically.
    await act(async () => {
      wsHandler?.({});
    });

    await waitFor(
      () => {
        expect(screen.queryByRole("alert")).toBeNull();
      },
      { timeout: 2000 },
    );
  });
});
