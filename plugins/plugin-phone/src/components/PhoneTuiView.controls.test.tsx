// @vitest-environment jsdom

// Drives the *rendered* TUI controls through the DOM (the existing
// PhoneTuiView.test.ts exercises the interact() capability bridge as a separate
// API; here we click the actual on-screen buttons and fill the actual inputs).

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const phoneBridge = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listRecentCalls: vi.fn(),
  placeCall: vi.fn(),
  openDialer: vi.fn(),
  saveCallTranscript: vi.fn(),
}));

vi.mock("@elizaos/capacitor-phone", () => ({ Phone: phoneBridge }));

import { PhoneTuiView } from "./PhoneAppView";

const sampleStatus = {
  hasTelecom: true,
  canPlaceCalls: true,
  isDefaultDialer: true,
  defaultDialerPackage: "ai.eliza.app",
};

const sampleCalls = [
  {
    id: "call-1",
    number: "+15550100",
    cachedName: "Ada Lovelace",
    date: 1_700_000_000_000,
    durationSeconds: 32,
    type: "incoming",
    rawType: 1,
    isNew: false,
    phoneAccountId: null,
    geocodedLocation: null,
    transcription: null,
    voicemailUri: null,
    agentTranscript: null,
    agentSummary: null,
    agentTranscriptUpdatedAt: null,
  },
];

beforeEach(() => {
  phoneBridge.getStatus.mockResolvedValue(sampleStatus);
  phoneBridge.listRecentCalls.mockResolvedValue({ calls: sampleCalls });
  phoneBridge.placeCall.mockResolvedValue(undefined);
  phoneBridge.openDialer.mockResolvedValue(undefined);
  phoneBridge.saveCallTranscript.mockResolvedValue({
    updatedAt: 1_700_000_300_000,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PhoneTuiView rendered controls", () => {
  it("reflects the default-dialer status line from getStatus", async () => {
    render(React.createElement(PhoneTuiView));
    await screen.findByText("Ada Lovelace");
    expect(screen.getByText(/default dialer: yes ai\.eliza\.app/)).toBeTruthy();
  });

  it("open-dialer button calls Phone.openDialer with the normalized number", async () => {
    render(React.createElement(PhoneTuiView));
    await screen.findByText("Ada Lovelace");

    fireEvent.change(screen.getByRole("textbox", { name: "number" }), {
      target: { value: "555 010 0" },
    });
    fireEvent.click(screen.getByText("open-dialer"));
    await waitFor(() =>
      expect(phoneBridge.openDialer).toHaveBeenCalledWith({
        number: "5550100",
      }),
    );
  });

  it("backspace button trims the last character of the number input", async () => {
    render(React.createElement(PhoneTuiView));
    await screen.findByText("Ada Lovelace");
    const numberInput = screen.getByRole("textbox", {
      name: "number",
    }) as HTMLInputElement;
    fireEvent.change(numberInput, { target: { value: "12345" } });
    fireEvent.click(screen.getByText("backspace"));
    expect(numberInput.value).toBe("1234");
  });

  it("a TUI recent-call row loads its number into the dialer input", async () => {
    render(React.createElement(PhoneTuiView));
    const adaLabel = await screen.findByText("Ada Lovelace");
    fireEvent.click(adaLabel.closest("button") as HTMLButtonElement);
    const numberInput = screen.getByRole("textbox", {
      name: "number",
    }) as HTMLInputElement;
    expect(numberInput.value).toBe("+15550100");
  });

  it("refresh button re-loads phone state", async () => {
    render(React.createElement(PhoneTuiView));
    await screen.findByText("Ada Lovelace");
    expect(phoneBridge.listRecentCalls).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("refresh"));
    await waitFor(() =>
      expect(phoneBridge.listRecentCalls).toHaveBeenCalledTimes(2),
    );
  });

  it("save-transcript flow saves, clears the inputs, and refreshes", async () => {
    render(React.createElement(PhoneTuiView));
    await screen.findByText("Ada Lovelace");
    expect(phoneBridge.listRecentCalls).toHaveBeenCalledTimes(1);

    const callIdInput = screen.getByRole("textbox", {
      name: "call id",
    }) as HTMLInputElement;
    const transcriptInput = screen.getByRole("textbox", {
      name: "transcript",
    }) as HTMLTextAreaElement;
    const summaryInput = screen.getByRole("textbox", {
      name: "summary",
    }) as HTMLInputElement;
    const saveButton = screen.getByText("save-transcript") as HTMLButtonElement;

    // Disabled until both call-id and transcript are present.
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(callIdInput, { target: { value: "call-1" } });
    fireEvent.change(transcriptInput, {
      target: { value: "Talked about Bernoulli numbers." },
    });
    fireEvent.change(summaryInput, { target: { value: "math chat" } });
    expect(saveButton.disabled).toBe(false);

    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(phoneBridge.saveCallTranscript).toHaveBeenCalledWith({
        callId: "call-1",
        transcript: "Talked about Bernoulli numbers.",
        summary: "math chat",
      }),
    );
    // On success the transcript + summary clear and recent state is refreshed.
    await waitFor(() => expect(transcriptInput.value).toBe(""));
    expect(summaryInput.value).toBe("");
    await waitFor(() =>
      expect(phoneBridge.listRecentCalls).toHaveBeenCalledTimes(2),
    );
  });

  it("call button is disabled until the number normalizes and then places the call", async () => {
    render(React.createElement(PhoneTuiView));
    await screen.findByText("Ada Lovelace");
    const callButton = screen.getByText("call") as HTMLButtonElement;
    expect(callButton.disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "number" }), {
      target: { value: "+1 (555) 222-3333" },
    });
    expect(callButton.disabled).toBe(false);
    fireEvent.click(callButton);
    await waitFor(() =>
      expect(phoneBridge.placeCall).toHaveBeenCalledWith({
        number: "+15552223333",
      }),
    );
  });
});
