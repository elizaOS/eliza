// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeView } from "./HomeView";

const controllerMock = vi.hoisted(() => ({
  value: {
    waveformMode: "idle" as const,
    messages: [
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "I can open any view and keep the conversation moving.",
        createdAt: 1,
      },
      {
        id: "user-1",
        role: "user" as const,
        content: "show me the views",
        createdAt: 2,
      },
    ],
    canSend: true,
    recording: false,
    send: vi.fn(),
    toggleRecording: vi.fn(),
  },
}));

vi.mock("../../backgrounds/CloudVideoBackground", () => ({
  CloudVideoBackground: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="cloud-background">{children}</div>
  ),
}));

vi.mock("../voice/VoiceWaveform", () => ({
  VoiceWaveform: ({ mode }: { mode: string }) => (
    <div data-testid="voice-waveform" data-mode={mode} />
  ),
}));

vi.mock("../shell/ShellControllerContext", () => ({
  useShellControllerContext: () => controllerMock.value,
}));

afterEach(() => {
  cleanup();
  controllerMock.value.send.mockClear();
  controllerMock.value.toggleRecording.mockClear();
});

describe("HomeView", () => {
  it("renders clouds, waveform, concise assistant transcript, and the home composer", () => {
    render(<HomeView />);

    expect(screen.getByTestId("cloud-background")).toBeTruthy();
    expect(screen.getByTestId("voice-waveform")).toBeTruthy();
    expect(screen.getByTestId("home-assistant-transcript").textContent).toBe(
      "I can open any view and keep the conversation moving.",
    );
    expect(screen.getByTestId("home-chat-input")).toBeTruthy();
  });

  it("shows recent chats while typing and submits through the shared shell controller", () => {
    render(<HomeView />);

    const input = screen.getByTestId("home-chat-input") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "open terminal" } });

    expect(screen.getByTestId("home-recent-chats").textContent).toContain(
      "show me the views",
    );

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(controllerMock.value.send).toHaveBeenCalledWith("open terminal");
    expect(input.value).toBe("");
  });

  it("starts voice input from the home surface", () => {
    render(<HomeView />);

    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));

    expect(controllerMock.value.toggleRecording).toHaveBeenCalledTimes(1);
  });
});
