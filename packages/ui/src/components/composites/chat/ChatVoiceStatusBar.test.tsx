// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatVoiceStatusBar } from "./ChatVoiceStatusBar";

afterEach(() => {
  cleanup();
});

describe("ChatVoiceStatusBar", () => {
  it("does not render when visible=false", () => {
    const { container } = render(
      <ChatVoiceStatusBar status="listening" visible={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the status dot + label for the current status", () => {
    render(<ChatVoiceStatusBar status="thinking" />);
    expect(screen.getByTestId("chat-voice-status-label").textContent).toBe(
      "Thinking",
    );
    const root = screen.getByTestId("chat-voice-status-bar");
    expect(root.getAttribute("data-status")).toBe("thinking");
  });

  it("renders interim transcript", () => {
    render(
      <ChatVoiceStatusBar
        status="listening"
        interimTranscript="hello there"
      />,
    );
    const t = screen.getByTestId("chat-voice-interim-transcript");
    expect(t.textContent).toContain("hello there");
  });

  it("renders OWNER crown when speaker entityId matches ownerEntityId", () => {
    render(
      <ChatVoiceStatusBar
        status="listening"
        speaker={{ entityId: "shaw-entity-1", name: "Shaw" }}
        ownerEntityId="shaw-entity-1"
      />,
    );
    expect(screen.getByTestId("chat-voice-speaker-owner")).toBeTruthy();
  });

  it("does NOT render crown when speaker is not the owner", () => {
    render(
      <ChatVoiceStatusBar
        status="listening"
        speaker={{ entityId: "jill-entity-2", name: "Jill" }}
        ownerEntityId="shaw-entity-1"
      />,
    );
    expect(screen.queryByTestId("chat-voice-speaker-owner")).toBeNull();
    const pill = screen.getByTestId("chat-voice-speaker-pill");
    expect(pill.textContent).toContain("Jill");
  });

  it("renders latency badge with traffic-light tone (ok ≤500ms)", () => {
    render(
      <ChatVoiceStatusBar
        status="speaking"
        latency={{
          speechEndToFirstTokenMs: 250,
          speechEndToVoiceStartMs: 480,
          assistantStreamToVoiceStartMs: 230,
          firstSegmentCached: false,
        }}
      />,
    );
    const badge = screen.getByTestId("chat-voice-latency-badge");
    expect(badge.getAttribute("data-tone")).toBe("ok");
    expect(badge.textContent).toContain("480 ms");
  });

  it("renders 'warn' tone for ≤1500ms latency", () => {
    render(
      <ChatVoiceStatusBar
        status="speaking"
        latency={{
          speechEndToFirstTokenMs: 800,
          speechEndToVoiceStartMs: 1100,
          assistantStreamToVoiceStartMs: 700,
          firstSegmentCached: false,
        }}
      />,
    );
    expect(
      screen.getByTestId("chat-voice-latency-badge").getAttribute("data-tone"),
    ).toBe("warn");
  });

  it("renders 'danger' tone for >1500ms latency", () => {
    render(
      <ChatVoiceStatusBar
        status="speaking"
        latency={{
          speechEndToFirstTokenMs: 2200,
          speechEndToVoiceStartMs: 2400,
          assistantStreamToVoiceStartMs: 1900,
          firstSegmentCached: false,
        }}
      />,
    );
    expect(
      screen.getByTestId("chat-voice-latency-badge").getAttribute("data-tone"),
    ).toBe("danger");
  });

  it("renders 'cached' indicator when firstSegmentCached is true", () => {
    render(
      <ChatVoiceStatusBar
        status="speaking"
        latency={{
          speechEndToFirstTokenMs: 100,
          speechEndToVoiceStartMs: 200,
          assistantStreamToVoiceStartMs: 90,
          firstSegmentCached: true,
        }}
      />,
    );
    const badge = screen.getByTestId("chat-voice-latency-badge");
    expect(badge.textContent?.toLowerCase()).toContain("cached");
  });
});
