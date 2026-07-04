// @vitest-environment jsdom

/**
 * Behaviour coverage for MeetingJoinBar: real render in jsdom driving the
 * meeting-URL paste/validation and join flow.
 */

import type { MeetingSession } from "@elizaos/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingJoinBar } from "./MeetingJoinBar";

afterEach(cleanup);

function renderBar(
  props: Partial<React.ComponentProps<typeof MeetingJoinBar>> = {},
) {
  const onJoin = vi.fn();
  const onStop = vi.fn();
  render(
    <MeetingJoinBar
      activeMeetings={[]}
      onJoin={onJoin}
      onStop={onStop}
      {...props}
    />,
  );
  return { onJoin, onStop };
}

const session: MeetingSession = {
  id: "m1",
  platform: "zoom",
  meetingUrl: "https://app.zoom.us/wc/1234567890/join",
  nativeMeetingId: "1234567890",
  botName: "Eliza",
  status: "active",
  requestedAt: 1_700_000_000_000,
  participants: [],
};

describe("MeetingJoinBar", () => {
  it("disables submit and shows the invalid hint for an unrecognized URL", () => {
    renderBar();
    const input = screen.getByTestId("meeting-url-input");
    fireEvent.change(input, { target: { value: "https://example.com/call" } });
    expect(screen.getByTestId("meeting-url-invalid")).toBeTruthy();
    expect(screen.queryByTestId("meeting-platform-hint")).toBeNull();
    expect(
      (screen.getByTestId("meeting-join-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shows no error for an empty input", () => {
    renderBar();
    expect(screen.queryByTestId("meeting-url-invalid")).toBeNull();
    expect(
      (screen.getByTestId("meeting-join-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it.each([
    ["https://meet.google.com/abc-defg-hij", "Google Meet"],
    ["https://us02web.zoom.us/j/1234567890?pwd=x", "Zoom"],
    ["https://teams.microsoft.com/meet/93841112345", "Microsoft Teams"],
  ])("recognizes %s and shows the platform hint", (url, label) => {
    renderBar();
    fireEvent.change(screen.getByTestId("meeting-url-input"), {
      target: { value: url },
    });
    expect(screen.getByTestId("meeting-platform-hint").textContent).toContain(
      label,
    );
    expect(screen.queryByTestId("meeting-url-invalid")).toBeNull();
    expect(
      (screen.getByTestId("meeting-join-submit") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("submits the canonical URL, platform, and optional bot name", () => {
    const { onJoin } = renderBar();
    fireEvent.change(screen.getByTestId("meeting-url-input"), {
      target: { value: "https://meet.google.com/abcdefghij" },
    });
    fireEvent.change(screen.getByTestId("meeting-bot-name"), {
      target: { value: "Notetaker" },
    });
    fireEvent.submit(screen.getByTestId("meeting-join-form"));
    expect(onJoin).toHaveBeenCalledWith({
      platform: "google_meet",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      botName: "Notetaker",
    });
    // input clears after submit
    expect(
      (screen.getByTestId("meeting-url-input") as HTMLInputElement).value,
    ).toBe("");
  });

  it("omits botName when left blank and never submits an invalid URL", () => {
    const { onJoin } = renderBar();
    fireEvent.submit(screen.getByTestId("meeting-join-form"));
    expect(onJoin).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("meeting-url-input"), {
      target: { value: "https://meet.google.com/abc-defg-hij" },
    });
    fireEvent.submit(screen.getByTestId("meeting-join-form"));
    expect(onJoin).toHaveBeenCalledWith({
      platform: "google_meet",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
    });
  });

  it("does not submit while a join is in flight", () => {
    const { onJoin } = renderBar({ joining: true });
    fireEvent.change(screen.getByTestId("meeting-url-input"), {
      target: { value: "https://meet.google.com/abc-defg-hij" },
    });
    fireEvent.submit(screen.getByTestId("meeting-join-form"));
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("lists active sessions with a Stop control", () => {
    const { onStop } = renderBar({ activeMeetings: [session] });
    expect(screen.getByTestId("active-meeting-m1").textContent).toContain(
      "Zoom",
    );
    expect(screen.getByTestId("active-meeting-m1").textContent).toContain(
      "In meeting",
    );
    fireEvent.click(screen.getByTestId("stop-meeting-m1"));
    expect(onStop).toHaveBeenCalledWith("m1");
  });

  it("renders the join error", () => {
    renderBar({ error: "Bot could not join" });
    expect(screen.getByRole("alert").textContent).toBe("Bot could not join");
  });
});
