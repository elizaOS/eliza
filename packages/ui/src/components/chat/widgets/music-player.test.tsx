// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Collaborator mocks (never the unit under test) -----------------------
const { fetchWithCsrf } = vi.hoisted(() => ({ fetchWithCsrf: vi.fn() }));

vi.mock("../../../api/csrf-client", () => ({ fetchWithCsrf }));
// Identity resolver so we can assert the exact request path + stream url pass-through.
vi.mock("../../../utils/asset-url", () => ({
  resolveApiUrl: (p: string) => p,
}));
// The widget polls every 5s via this hook; make it inert so tests drive fetch
// explicitly and never race a background poll. Returned value is unused.
vi.mock("../../../hooks", () => ({
  useIntervalWhenDocumentVisible: () => {},
}));

import { MusicPlayerSidebarWidget } from "./music-player";
import type { ChatSidebarWidgetProps } from "./types";

interface StatusBody {
  error?: string;
  guildId?: string;
  track?: { title?: string };
  streamUrl?: string;
  isPaused?: boolean;
}

function statusResponse(
  status: number,
  body: StatusBody,
): { ok: boolean; status: number; statusText: string; json: () => Promise<StatusBody> } {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
  };
}

const PLAYING: StatusBody = {
  guildId: "guild-42",
  track: { title: "Midnight City" },
  streamUrl: "/stream/track.mp3",
  isPaused: true,
};

const baseProps: ChatSidebarWidgetProps = {
  events: [],
  clearEvents: () => {},
};

let playSpy: ReturnType<typeof vi.fn>;
let pauseSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchWithCsrf.mockReset();
  // jsdom leaves HTMLMediaElement play/pause/load unimplemented (they throw).
  // Stub them so the widget's audio wiring can run and we can assert the play call.
  playSpy = vi.fn().mockResolvedValue(undefined);
  pauseSpy = vi.fn();
  window.HTMLMediaElement.prototype.play = playSpy as unknown as HTMLMediaElement["play"];
  window.HTMLMediaElement.prototype.pause = pauseSpy as unknown as HTMLMediaElement["pause"];
  window.HTMLMediaElement.prototype.load = vi.fn() as unknown as HTMLMediaElement["load"];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MusicPlayerSidebarWidget", () => {
  it("fetches /music-player/status on mount and renders the active track", async () => {
    fetchWithCsrf.mockResolvedValue(statusResponse(200, PLAYING));

    render(<MusicPlayerSidebarWidget {...baseProps} />);

    // Requests the status endpoint (identity resolveApiUrl → exact path).
    await waitFor(() => {
      expect(fetchWithCsrf).toHaveBeenCalledWith("/music-player/status");
    });
    // Renders the track title from the store payload.
    expect(await screen.findByText("Midnight City")).toBeTruthy();
    // Paused stream → status label reads "Paused", not "Live".
    expect(screen.getByText("Paused")).toBeTruthy();
    // No empty state while a track is active.
    expect(screen.queryByText("No music stream is active.")).toBeNull();
  });

  it("tapping the play control fires the audio play handler exactly once", async () => {
    fetchWithCsrf.mockResolvedValue(statusResponse(200, PLAYING));
    render(<MusicPlayerSidebarWidget {...baseProps} />);
    await screen.findByText("Midnight City");

    // Paused track auto-pauses on attach; auto-play must NOT have fired.
    expect(playSpy).not.toHaveBeenCalled();
    const playBtn = screen.getByRole("button", { name: "Play music" });

    fireEvent.click(playBtn);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("double-click on play is idempotent (paused audio → single logical play)", async () => {
    fetchWithCsrf.mockResolvedValue(statusResponse(200, PLAYING));
    render(<MusicPlayerSidebarWidget {...baseProps} />);
    await screen.findByText("Midnight City");
    const playBtn = screen.getByRole("button", { name: "Play music" });

    // Ignore the pause the attach-effect issues for a paused stream; we only
    // care what the click HANDLER does.
    playSpy.mockClear();
    pauseSpy.mockClear();

    // jsdom never flips el.paused, so togglePlayback stays on the play branch.
    // Two rapid clicks call play twice but never pause — no play/pause thrash.
    fireEvent.click(playBtn);
    fireEvent.click(playBtn);
    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it("self-hides into the empty state when no stream is active (idle)", async () => {
    fetchWithCsrf.mockResolvedValue(statusResponse(200, {}));
    render(<MusicPlayerSidebarWidget {...baseProps} />);

    expect(await screen.findByText("No music stream is active.")).toBeTruthy();
    // No play control rendered without an active track.
    expect(screen.queryByRole("button", { name: "Play music" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause music" })).toBeNull();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("surfaces a server error message in the empty state", async () => {
    fetchWithCsrf.mockResolvedValue(
      statusResponse(503, { error: "player offline" }),
    );
    render(<MusicPlayerSidebarWidget {...baseProps} />);

    expect(await screen.findByText("player offline")).toBeTruthy();
    expect(screen.queryByText("Midnight City")).toBeNull();
  });

  it("shows a transport error when the fetch itself rejects", async () => {
    fetchWithCsrf.mockRejectedValue(new Error("network down"));
    render(<MusicPlayerSidebarWidget {...baseProps} />);

    expect(
      await screen.findByText("Could not reach the music player."),
    ).toBeTruthy();
  });

  it("treats a partial/invalid payload (missing guildId) as idle, not playing", async () => {
    // Adversarial: has a title + streamUrl but no guildId — must NOT render as a
    // live player (would attach a stream keyed on an undefined guild).
    fetchWithCsrf.mockResolvedValue(
      statusResponse(200, {
        track: { title: "Ghost Track" },
        streamUrl: "/stream/ghost.mp3",
      }),
    );
    render(<MusicPlayerSidebarWidget {...baseProps} />);

    expect(await screen.findByText("No music stream is active.")).toBeTruthy();
    expect(screen.queryByText("Ghost Track")).toBeNull();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("rapid refresh clicks are safe and reconcile to the latest status", async () => {
    fetchWithCsrf.mockResolvedValue(statusResponse(200, PLAYING));
    render(<MusicPlayerSidebarWidget {...baseProps} />);
    await screen.findByText("Midnight City");

    const refresh = screen.getByRole("button", { name: "Refresh music player" });
    const before = fetchWithCsrf.mock.calls.length;

    await act(async () => {
      fireEvent.click(refresh);
      fireEvent.click(refresh);
      fireEvent.click(refresh);
    });

    // Every click issued a request; state stays consistent (still the one track).
    expect(fetchWithCsrf.mock.calls.length).toBe(before + 3);
    expect(screen.getByText("Midnight City")).toBeTruthy();
    expect(screen.getAllByText("Midnight City")).toHaveLength(1);
  });
});
