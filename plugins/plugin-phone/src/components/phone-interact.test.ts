// @vitest-environment jsdom

// Agent-facing terminal capability bridge (interact) + the PhoneAppView overlay
// dialer resilience. The terminal SURFACE itself is now the unified
// PhoneSpatialView (covered in PhoneSpatialView.test.tsx); this file guards the
// capability handler the agent terminal calls and the overlay dialer's
// post-failure usability.

import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const phoneBridge = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listRecentCalls: vi.fn(),
  placeCall: vi.fn(),
  openDialer: vi.fn(),
  saveCallTranscript: vi.fn(),
}));

vi.mock("@elizaos/capacitor-phone", () => ({
  Phone: phoneBridge,
}));

import { PhoneAppView } from "./PhoneAppView";
import { interact } from "./PhoneAppView.interact";

const t = (key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key;

const sampleStatus = {
  hasTelecom: true,
  canPlaceCalls: true,
  isDefaultDialer: false,
  defaultDialerPackage: "com.android.dialer",
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
  {
    id: "call-2",
    number: "+15550200",
    cachedName: null,
    date: 1_700_000_100_000,
    durationSeconds: 0,
    type: "missed",
    rawType: 3,
    isNew: true,
    phoneAccountId: null,
    geocodedLocation: null,
    transcription: null,
    voicemailUri: null,
    agentTranscript: "Missed callback.",
    agentSummary: "Missed call",
    agentTranscriptUpdatedAt: 1_700_000_200_000,
  },
];

function mockBridge() {
  phoneBridge.getStatus.mockResolvedValue(sampleStatus);
  phoneBridge.listRecentCalls.mockResolvedValue({ calls: sampleCalls });
  phoneBridge.placeCall.mockResolvedValue(undefined);
  phoneBridge.openDialer.mockResolvedValue(undefined);
  phoneBridge.saveCallTranscript.mockResolvedValue({
    updatedAt: 1_700_000_300_000,
  });
}

function overlayContext(exitToApps = vi.fn()) {
  return {
    exitToApps,
    uiTheme: "light" as const,
    t,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("phone terminal capability bridge", () => {
  it("supports terminal capabilities for state, dialing, dialer, and transcripts", async () => {
    mockBridge();

    await expect(
      interact("terminal-phone-state", { limit: 2 }),
    ).resolves.toMatchObject({
      viewType: "tui",
      status: sampleStatus,
      calls: [
        {
          id: "call-1",
          number: "+15550100",
          label: "Ada Lovelace",
          type: "incoming",
        },
        {
          id: "call-2",
          number: "+15550200",
          label: "+15550200",
          type: "missed",
          agentSummary: "Missed call",
        },
      ],
    });
    expect(phoneBridge.listRecentCalls).toHaveBeenCalledWith({ limit: 2 });

    await expect(
      interact("terminal-place-call", { number: "+1 (555) 333-4444" }),
    ).resolves.toEqual({
      placed: true,
      number: "+15553334444",
      viewType: "tui",
    });

    await expect(
      interact("terminal-open-dialer", { number: "555 999 0000" }),
    ).resolves.toEqual({
      opened: true,
      number: "5559990000",
      viewType: "tui",
    });
    expect(phoneBridge.openDialer).toHaveBeenCalledWith({
      number: "5559990000",
    });

    await expect(
      interact("terminal-save-call-transcript", {
        callId: "call-1",
        transcript: "Call transcript",
        summary: "Short summary",
      }),
    ).resolves.toEqual({
      saved: true,
      updatedAt: 1_700_000_300_000,
      viewType: "tui",
    });
    expect(phoneBridge.saveCallTranscript).toHaveBeenCalledWith({
      callId: "call-1",
      transcript: "Call transcript",
      summary: "Short summary",
    });
  });

  it("sanitizes hostile terminal state params before calling the native bridge", async () => {
    mockBridge();

    await expect(
      interact("terminal-phone-state", {
        limit: Number.POSITIVE_INFINITY,
        number: "../../etc/passwd",
      }),
    ).resolves.toMatchObject({ viewType: "tui" });
    expect(phoneBridge.listRecentCalls).toHaveBeenLastCalledWith({
      limit: 50,
    });

    await interact("terminal-phone-state", {
      limit: -10,
      number: "+1 (555) 123-4567?x=<script>",
    });
    expect(phoneBridge.listRecentCalls).toHaveBeenLastCalledWith({
      limit: 1,
      number: "+15551234567",
    });

    await interact("terminal-phone-state", { limit: 10_000 });
    expect(phoneBridge.listRecentCalls).toHaveBeenLastCalledWith({
      limit: 200,
    });
  });

  it("keeps PhoneAppView dialer state usable after a native place-call failure", async () => {
    phoneBridge.placeCall.mockRejectedValue(new Error("CALL_PHONE denied"));

    render(React.createElement(PhoneAppView, overlayContext()));

    fireEvent.click(screen.getByTestId("phone-dial-key-5"));
    fireEvent.click(screen.getByTestId("phone-dial-call"));

    await screen.findByText("CALL_PHONE denied");
    expect(phoneBridge.placeCall).toHaveBeenCalledWith({ number: "5" });

    fireEvent.click(screen.getByTestId("phone-dial-backspace"));
    expect(screen.getByText("Enter a number")).toBeTruthy();
  });
});
