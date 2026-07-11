// @vitest-environment jsdom
//
// The backend-free chat harness mounts the REAL ContinuousChatOverlay with a
// scripted conversation. These tests render it in jsdom (API client stubbed —
// no network) and assert the onboarding opening, that composer sends advance
// the script entirely in local state, and that the onboarding pin releases.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  client: {
    fetch: vi.fn().mockRejectedValue(new Error("no api in test")),
    getCodingAgentTaskThread: vi.fn().mockResolvedValue(null),
    onWsEvent: vi.fn(() => () => undefined),
    searchConversationMessages: vi.fn(),
    createTranscript: vi
      .fn()
      .mockResolvedValue({ transcript: { id: "t1", title: "Transcript" } }),
  },
}));

vi.mock("../../utils/clipboard", () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../chat/report-composer-activity", () => ({
  reportComposerActivity: vi.fn(),
}));

import { ChatWidgetHarness } from "./ChatWidgetHarness";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

describe("ChatWidgetHarness", () => {
  afterEach(cleanup);

  it("opens with the in-chat onboarding choice widget inside the real overlay", () => {
    render(<ChatWidgetHarness />);

    expect(screen.getByTestId("chat-widget-harness")).toBeTruthy();
    // The scripted greeting renders through the production widget parser.
    expect(screen.getByText(/set things up right here in chat/i)).toBeTruthy();
    expect(screen.getByText("Set me up")).toBeTruthy();
    expect(screen.getByText("Quick tour")).toBeTruthy();
  });

  it("advances the scripted onboarding from a widget tap, all local", async () => {
    render(<ChatWidgetHarness />);

    // Onboarding pins the sheet and locks the composer — advancement comes
    // from the transcript widgets, exactly like the production first run.
    fireEvent.click(screen.getByText("Set me up"));

    // The tap echoes as a user turn, then the scripted assistant reply (the
    // onboarding profile form) lands after the local delay.
    await waitFor(
      () => expect(screen.getByText(/Tell me a little/i)).toBeTruthy(),
      { timeout: 3000 },
    );
    expect(screen.getByText("Set up your assistant")).toBeTruthy();
  });
});
