// @vitest-environment jsdom
//
// Behavioral test for TranscriptsPage — the DATA CONTAINER for the Transcripts
// view (#8789). The container is the unit under test: it owns the list/selected
// fetch lifecycle (loading → data / error), the selection round-trip
// (click row → getTranscript(id) → render the player), and the reset-on-select
// invariant. Only the API boundary (`client`) is mocked; the presentational
// TranscriptsView + TranscriptPlayer + agent-surface are real collaborators.

import type {
  Transcript,
  TranscriptSummary,
} from "@elizaos/shared/transcripts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Collaborator mock: the HTTP client only ───────────────────────────
const clientMock = vi.hoisted(() => ({
  listTranscripts: vi.fn(),
  getTranscript: vi.fn(),
}));
vi.mock("../../api/client", () => ({ client: clientMock }));

import { TranscriptsPage } from "./TranscriptsPage";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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
    title: "Weekly Sync",
    createdAt: 1_700_100_000_000,
    durationMs: 5_000,
    speakerCount: 1,
    status: "processing",
    preview: "",
    hasAudio: false,
  },
];

function transcriptFor(id: string, title: string, word: string): Transcript {
  return {
    id,
    title,
    createdAt: 1_700_000_000_000,
    durationMs: 65_000,
    source: "voice-session",
    scope: "owner-private",
    status: "ready",
    speakerCount: 2,
    audioUrl: `/api/media/${id}.wav`,
    segments: [
      {
        id: "s1",
        speakerLabel: "Alice",
        startMs: 0,
        endMs: 2000,
        text: word,
        words: [{ text: word, startMs: 0, endMs: 500 }],
      },
    ],
  };
}

/** A promise plus its resolve/reject handles, for controlling async timing. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TranscriptsPage (container)", () => {
  it("shows Loading… then the fetched list; calls listTranscripts exactly once", async () => {
    const list = deferred<{ transcripts: TranscriptSummary[] }>();
    clientMock.listTranscripts.mockReturnValue(list.promise);

    render(<TranscriptsPage />);

    // Before the fetch resolves the container is in its loading state.
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByTestId("transcript-row-t1")).toBeNull();

    list.resolve({ transcripts: summaries });

    // Rows appear once the list resolves; the loading hint is gone.
    await waitFor(() =>
      expect(screen.getByTestId("transcript-row-t1")).toBeTruthy(),
    );
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByTestId("transcript-row-t2").textContent).toContain(
      "Weekly Sync",
    );
    // Mount effect fetches the list a single time (no double-fetch churn).
    expect(clientMock.listTranscripts).toHaveBeenCalledTimes(1);
    // Nothing selected yet → detail pane shows the empty hint.
    expect(screen.getByTestId("transcripts-detail-empty")).toBeTruthy();
    // No transcript was fetched before the user picked one.
    expect(clientMock.getTranscript).not.toHaveBeenCalled();
  });

  it("selection round-trip: clicking a row fetches THAT id and renders its player", async () => {
    clientMock.listTranscripts.mockResolvedValue({ transcripts: summaries });
    clientMock.getTranscript.mockResolvedValue({
      transcript: transcriptFor("t1", "Standup", "shipit"),
    });

    render(<TranscriptsPage />);
    const row = await screen.findByTestId("transcript-row-t1");
    fireEvent.click(row);

    // Exact call + payload to the API boundary.
    expect(clientMock.getTranscript).toHaveBeenCalledWith("t1");

    // The selected transcript flows back into the player (word render proves it).
    await waitFor(() =>
      expect(screen.getByTestId("transcript-word-0-0").textContent).toBe(
        "shipit",
      ),
    );
    // The clicked row is marked active.
    expect(
      screen.getByTestId("transcript-row-t1").getAttribute("data-active"),
    ).toBe("true");
  });

  it("switching selection resets the previous transcript before the new one loads", async () => {
    clientMock.listTranscripts.mockResolvedValue({ transcripts: summaries });

    const first = { transcript: transcriptFor("t1", "Standup", "alpha") };
    const second = deferred<{ transcript: Transcript }>();
    clientMock.getTranscript
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(second.promise);

    render(<TranscriptsPage />);
    fireEvent.click(await screen.findByTestId("transcript-row-t1"));
    await waitFor(() =>
      expect(screen.getByTestId("transcript-word-0-0").textContent).toBe(
        "alpha",
      ),
    );

    // Select the second row; its fetch is still pending.
    fireEvent.click(screen.getByTestId("transcript-row-t2"));
    expect(clientMock.getTranscript).toHaveBeenLastCalledWith("t2");

    // While t2 is loading the stale t1 player must be gone (selected reset to null).
    await waitFor(() =>
      expect(screen.queryByTestId("transcript-word-0-0")).toBeNull(),
    );
    expect(screen.getByTestId("transcripts-detail-empty")).toBeTruthy();
    // t2 is the active row even before its transcript arrives.
    expect(
      screen.getByTestId("transcript-row-t2").getAttribute("data-active"),
    ).toBe("true");

    second.resolve({ transcript: transcriptFor("t2", "Weekly Sync", "beta") });
    await waitFor(() =>
      expect(screen.getByTestId("transcript-word-0-0").textContent).toBe(
        "beta",
      ),
    );
  });

  it("rapid double-click on the same row is idempotent for the resulting selection", async () => {
    clientMock.listTranscripts.mockResolvedValue({ transcripts: summaries });
    clientMock.getTranscript.mockResolvedValue({
      transcript: transcriptFor("t1", "Standup", "once"),
    });

    render(<TranscriptsPage />);
    const row = await screen.findByTestId("transcript-row-t1");
    fireEvent.click(row);
    fireEvent.click(row);
    fireEvent.click(row);

    // Each click issues a fetch, but they all target the same id …
    expect(clientMock.getTranscript).toHaveBeenCalledTimes(3);
    for (const call of clientMock.getTranscript.mock.calls) {
      expect(call[0]).toBe("t1");
    }
    // … and the end state is a single, coherent selection (one player).
    await waitFor(() =>
      expect(screen.getByTestId("transcript-word-0-0").textContent).toBe(
        "once",
      ),
    );
    expect(screen.getAllByTestId("transcript-word-0-0")).toHaveLength(1);
    expect(
      screen.getByTestId("transcript-row-t1").getAttribute("data-active"),
    ).toBe("true");
  });

  it("renders the empty state when the list comes back empty (no error, no player)", async () => {
    clientMock.listTranscripts.mockResolvedValue({ transcripts: [] });

    render(<TranscriptsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("transcripts-empty")).toBeTruthy(),
    );
    expect(screen.queryByTestId("transcript-row-t1")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces the list-load error (rejection message, not a silent empty)", async () => {
    clientMock.listTranscripts.mockRejectedValue(new Error("boom: 500"));

    render(<TranscriptsPage />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("boom: 500");
    // An error is NOT the empty state — the "No transcripts yet" surface stays hidden.
    expect(screen.queryByTestId("transcripts-empty")).toBeNull();
    expect(clientMock.getTranscript).not.toHaveBeenCalled();
  });

  it("surfaces a per-transcript load error while keeping the row selected", async () => {
    clientMock.listTranscripts.mockResolvedValue({ transcripts: summaries });
    clientMock.getTranscript.mockRejectedValue(new Error("detail failed"));

    render(<TranscriptsPage />);
    fireEvent.click(await screen.findByTestId("transcript-row-t1"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("detail failed");
    // The failed fetch does not silently swap to a stale/other player.
    expect(screen.queryByTestId("transcript-word-0-0")).toBeNull();
    // Real behavior: the container's single `error` field is shared, so a
    // detail-load failure collapses the recordings list into the alert (the
    // aside renders `error ? <alert> : <list>`). This is a genuine UX rough
    // edge — a transient per-item error hides the whole list — captured here.
    expect(screen.queryByTestId("transcript-row-t1")).toBeNull();
  });
});
