// @vitest-environment jsdom

// Drives the unified PhoneView (the single GUI/XR data wrapper) through the
// rendered DOM: the same component the bundle exports for both the "gui" and
// "xr" modalities. Asserts the dialer keypad, place-call, backspace, leading-+,
// the recent-call rows, the Contacts link, and the error path all reach the
// native bridge with the exact normalized arguments — functional parity with
// the retired hand-written PhonePluginView/PhoneTuiView surfaces.

import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

configure({ asyncUtilTimeout: 5000 });

const phoneBridge = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listRecentCalls: vi.fn(),
  placeCall: vi.fn(),
  openDialer: vi.fn(),
  saveCallTranscript: vi.fn(),
  checkPermissions: vi.fn(async () => ({ phone: "granted" })),
  requestPermissions: vi.fn(async () => ({ phone: "granted" })),
}));

vi.mock("@elizaos/capacitor-phone", () => ({ Phone: phoneBridge }));

import { __setNavigateViewPayloadForTests } from "@elizaos/ui/app-navigate-view";
import { PhoneView } from "./PhoneView";

function makeCall(over: Record<string, unknown>) {
  return {
    id: "call-x",
    number: "+10000000000",
    cachedName: null,
    date: 1_700_000_000_000,
    durationSeconds: 0,
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
    ...over,
  };
}

const recentCalls = [
  makeCall({
    id: "call-1",
    number: "+15550100",
    cachedName: "Ada Lovelace",
    type: "incoming",
  }),
  makeCall({
    id: "call-2",
    number: "+15550200",
    cachedName: null,
    type: "missed",
    isNew: true,
  }),
  makeCall({
    id: "call-3",
    number: "+15550300",
    cachedName: "Grace Hopper",
    type: "outgoing",
  }),
];

function button(agentId: string): HTMLButtonElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  phoneBridge.getStatus.mockResolvedValue({
    hasTelecom: true,
    canPlaceCalls: true,
    isDefaultDialer: false,
    defaultDialerPackage: "com.android.dialer",
  });
  phoneBridge.listRecentCalls.mockResolvedValue({ calls: recentCalls });
  phoneBridge.placeCall.mockResolvedValue(undefined);
  phoneBridge.openDialer.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PhoneView — unified GUI/XR dialer", () => {
  it("prefills the dialer from a generic navigation payload", async () => {
    __setNavigateViewPayloadForTests("phone", { number: " +1 (555) 0100 " });

    render(React.createElement(PhoneView));
    await screen.findByText("Ada Lovelace");

    expect(
      Array.from(document.querySelectorAll('[data-spatial-kind="text"]')).some(
        (n) => n.textContent === "+15550100",
      ),
    ).toBe(true);
  });

  it("builds a multi-digit number across keys and places the normalized call", async () => {
    render(React.createElement(PhoneView));
    await screen.findByText("Ada Lovelace");

    for (const d of ["5", "5", "5", "1", "2", "3", "4"]) {
      fireEvent.click(button(`key-${d}`));
    }
    expect(
      Array.from(document.querySelectorAll('[data-spatial-kind="text"]')).some(
        (n) => n.textContent === "5551234",
      ),
    ).toBe(true);

    fireEvent.click(button("call"));
    await waitFor(() =>
      expect(phoneBridge.placeCall).toHaveBeenCalledWith({ number: "5551234" }),
    );
  });

  it("inserts a leading + only when the input is empty", async () => {
    render(React.createElement(PhoneView));
    await screen.findByText("Ada Lovelace");

    fireEvent.click(button("plus"));
    fireEvent.click(button("key-4"));
    fireEvent.click(button("plus")); // non-empty -> no-op
    expect(
      Array.from(document.querySelectorAll('[data-spatial-kind="text"]')).some(
        (n) => n.textContent === "+4",
      ),
    ).toBe(true);
  });

  it("backspace removes the last digit", async () => {
    render(React.createElement(PhoneView));
    await screen.findByText("Ada Lovelace");
    fireEvent.click(button("key-9"));
    fireEvent.click(button("key-8"));
    fireEvent.click(button("backspace"));
    expect(
      Array.from(document.querySelectorAll('[data-spatial-kind="text"]')).some(
        (n) => n.textContent === "9",
      ),
    ).toBe(true);
  });

  it("renders the error text when the native bridge rejects", async () => {
    phoneBridge.placeCall.mockRejectedValue(new Error("CALL_PHONE denied"));
    render(React.createElement(PhoneView));
    await screen.findByText("Ada Lovelace");
    fireEvent.click(button("key-1"));
    fireEvent.click(button("call"));
    await screen.findByText("CALL_PHONE denied");
    expect(phoneBridge.placeCall).toHaveBeenCalledWith({ number: "1" });
  });

  it("keeps the dialer usable after a native place-call failure", async () => {
    phoneBridge.placeCall.mockRejectedValue(new Error("CALL_PHONE denied"));
    render(React.createElement(PhoneView));
    await screen.findByText("Ada Lovelace");
    fireEvent.click(button("key-5"));
    fireEvent.click(button("call"));
    await screen.findByText("CALL_PHONE denied");
    expect(phoneBridge.placeCall).toHaveBeenCalledWith({ number: "5" });
    // The dialer stays interactive: backspace still clears the stuck digit.
    fireEvent.click(button("backspace"));
    await waitFor(() =>
      expect(
        Array.from(
          document.querySelectorAll('[data-spatial-kind="text"]'),
        ).some((n) => n.textContent === "5"),
      ).toBe(false),
    );
  });
});

describe("PhoneView — recent calls", () => {
  it("loads recent rows on mount with names and a per-row Call action", async () => {
    render(React.createElement(PhoneView));
    await screen.findByText("Ada Lovelace");
    expect(phoneBridge.listRecentCalls).toHaveBeenCalledWith({ limit: 50 });
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText("+15550200")).toBeTruthy();
  });

  it("places a call to the row number when a recent row's Call is clicked", async () => {
    render(React.createElement(PhoneView));
    await screen.findByText("Ada Lovelace");
    fireEvent.click(button("call:call-1"));
    await waitFor(() =>
      expect(phoneBridge.placeCall).toHaveBeenCalledWith({
        number: "+15550100",
      }),
    );
  });

  it("renders the error banner when the call-log fetch rejects", async () => {
    phoneBridge.listRecentCalls.mockRejectedValue(
      new Error("READ_CALL_LOG denied"),
    );
    render(React.createElement(PhoneView));
    await screen.findByText("READ_CALL_LOG denied");
  });

  it("does not fetch the call log when requestPermissions throws (#10196)", async () => {
    // A failed permission request must block the read; otherwise we call
    // listRecentCalls, which rejects and Capacitor logs the raw rejection.
    phoneBridge.requestPermissions.mockRejectedValueOnce(
      new Error("bridge unavailable"),
    );
    render(React.createElement(PhoneView));
    await screen.findByText(/Phone access is needed/i);
    expect(phoneBridge.listRecentCalls).not.toHaveBeenCalled();
  });

  it("does not fetch the call log when phone permission is denied", async () => {
    phoneBridge.requestPermissions.mockResolvedValueOnce({ phone: "denied" });
    render(React.createElement(PhoneView));
    await screen.findByText(/Phone access is needed/i);
    expect(phoneBridge.listRecentCalls).not.toHaveBeenCalled();
  });

  it("polls the recent call log on a quiet 20s interval", async () => {
    vi.useFakeTimers();
    try {
      render(React.createElement(PhoneView));
      // Initial load on mount (no manual Refresh control).
      await vi.waitFor(() =>
        expect(phoneBridge.listRecentCalls).toHaveBeenCalledTimes(1),
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(phoneBridge.listRecentCalls).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(phoneBridge.listRecentCalls).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PhoneView — navigation", () => {
  it("opens the system dialer via the open-dialer action", async () => {
    render(React.createElement(PhoneView));
    await screen.findByText("Ada Lovelace");
    fireEvent.click(button("key-5"));
    fireEvent.click(button("open-dialer"));
    await waitFor(() =>
      expect(phoneBridge.openDialer).toHaveBeenCalledWith({ number: "5" }),
    );
  });

  it("navigates to Contacts via the eliza:navigate:view bus", async () => {
    render(React.createElement(PhoneView));
    await screen.findByText("Ada Lovelace");
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("eliza:navigate:view", listener);
    try {
      fireEvent.click(button("contacts"));
    } finally {
      window.removeEventListener("eliza:navigate:view", listener);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({
      viewId: "contacts",
      viewPath: "/contacts",
    });
  });
});
