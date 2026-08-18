/**
 * Verifies the real chat composer scopes Capacitor's WebView-global iOS
 * accessory suppression to its own focus lifecycle, including the handoff to
 * a non-chat field. The native bridge is mocked; focus behavior is real jsdom.
 */
// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const accessoryMock = vi.hoisted(() => ({ setHidden: vi.fn() }));

vi.mock("./ios-chat-accessory-bar", () => ({
  setChatComposerAccessoryBarHidden: accessoryMock.setHidden,
}));

vi.mock("../composites/chat/ServingProviderChip", () => ({
  ServingProviderChip: () => <span data-testid="serving-provider-chip" />,
}));

vi.mock("../../api/client", () => ({
  client: {
    fetch: vi.fn().mockRejectedValue(new Error("no api in test")),
    createTranscript: vi
      .fn()
      .mockResolvedValue({ transcript: { id: "t1", title: "Transcript" } }),
    searchConversationMessages: vi.fn(),
  },
}));

import { ChatOverlay } from "./ChatOverlay";
import type { ShellController } from "./useShellController";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeController(): ShellController {
  return {
    phase: "summoned",
    messages: [
      { id: "a", role: "assistant", content: "hi", createdAt: 1 },
      { id: "b", role: "user", content: "hello", createdAt: 2 },
    ],
    canSend: true,
    responding: false,
    turnStatus: null,
    recording: false,
    transcript: "",
    transcriptionMode: false,
    modelStatus: { kind: "ready" },
    send: vi.fn(),
    stop: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    toggleRecording: vi.fn(),
    handsFree: false,
    toggleHandsFree: vi.fn(),
    toggleTranscriptionMode: vi.fn(),
    stopTranscriptionAndMic: vi.fn(),
    setDictationSink: vi.fn(),
    setTranscriptSessionSink: vi.fn(),
    setComposerHasDraft: vi.fn(),
    clearConversation: vi.fn(),
  } as unknown as ShellController;
}

describe("ChatOverlay iOS accessory bar", () => {
  it("restores the global accessory before a non-chat field takes focus", async () => {
    render(
      <>
        <ChatOverlay controller={makeController()} />
        <input aria-label="Settings field" />
      </>,
    );

    const composer = screen.getByLabelText("message");
    const settingsField = screen.getByLabelText("Settings field");
    expect(screen.getByTestId("serving-provider-chip")).toBeTruthy();

    act(() => composer.focus());
    await waitFor(() =>
      expect(accessoryMock.setHidden).toHaveBeenCalledWith(true),
    );

    act(() => settingsField.focus());
    await waitFor(() =>
      expect(accessoryMock.setHidden).toHaveBeenLastCalledWith(false),
    );
    expect(document.activeElement).toBe(settingsField);
  });

  it("restores the global accessory when a focused chat unmounts", async () => {
    const { unmount } = render(<ChatOverlay controller={makeController()} />);
    const composer = screen.getByLabelText("message");

    act(() => composer.focus());
    await waitFor(() =>
      expect(accessoryMock.setHidden).toHaveBeenLastCalledWith(true),
    );

    unmount();

    expect(accessoryMock.setHidden).toHaveBeenLastCalledWith(false);
  });
});
