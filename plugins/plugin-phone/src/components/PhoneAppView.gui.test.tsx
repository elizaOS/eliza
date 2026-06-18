// @vitest-environment jsdom

// Full populated/interactive coverage for the default GUI surface (PhoneAppView)
// and its xr twin (same component, registered with viewType "xr"). The TUI view
// is covered separately in PhoneTuiView.test.ts; here we drive every dialer and
// recent control through the rendered DOM and assert the native bridge is
// invoked with the exact normalized arguments. The address book lives in the
// separate Contacts view; the Phone app only links to it via the navigation bus.

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

// The recent pane lazy-loads through an async bridge call before its rows or
// error banner render. Under the full parallel `test:plugins` run the default
// 1000ms findBy/waitFor budget is occasionally exceeded, flaking the lane. Give
// the async utils headroom; queries still resolve as soon as the element
// appears, so this never slows the happy path.
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

vi.mock("@elizaos/capacitor-phone", () => ({
  Phone: phoneBridge,
}));

import { PhoneAppView, PhonePluginView } from "./PhoneAppView";

const t = (key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? key;

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
    date: 1_700_000_000_000,
    durationSeconds: 32,
    type: "incoming",
  }),
  makeCall({
    id: "call-2",
    number: "+15550200",
    cachedName: null,
    date: 1_700_000_100_000,
    durationSeconds: 0,
    type: "missed",
    isNew: true,
  }),
  makeCall({
    id: "call-3",
    number: "+15550300",
    cachedName: "Grace Hopper",
    date: 1_700_000_200_000,
    durationSeconds: 5,
    type: "outgoing",
  }),
];

function overlayContext(exitToApps = vi.fn()) {
  return { exitToApps, uiTheme: "light" as const, t };
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

function dialKey(digit: string) {
  fireEvent.click(screen.getByTestId(`phone-dial-key-${digit}`));
}

describe("PhoneAppView — dialer", () => {
  it("builds a multi-digit number across keys and places the normalized call", async () => {
    render(React.createElement(PhoneAppView, overlayContext()));

    // Empty state shows placeholder; Call + Backspace disabled.
    expect(screen.getByText("Enter a number")).toBeTruthy();
    expect(
      (screen.getByTestId("phone-dial-call") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("phone-dial-backspace") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    for (const d of ["5", "5", "5", "1", "2", "3", "4"]) dialKey(d);
    const display = document.querySelector("output");
    expect(display?.textContent).toBe("5551234");

    expect(
      (screen.getByTestId("phone-dial-call") as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByTestId("phone-dial-call"));
    await waitFor(() =>
      expect(phoneBridge.placeCall).toHaveBeenCalledWith({ number: "5551234" }),
    );
  });

  it("inserts a leading + only when the input is empty", () => {
    render(React.createElement(PhoneAppView, overlayContext()));
    const plus = screen.getByTestId("phone-dial-plus");

    fireEvent.click(plus);
    expect(document.querySelector("output")?.textContent).toBe("+");

    dialKey("4");
    fireEvent.click(plus); // non-empty -> no-op
    expect(document.querySelector("output")?.textContent).toBe("+4");
  });

  it("backspace removes the last digit and re-disables at empty", () => {
    render(React.createElement(PhoneAppView, overlayContext()));
    dialKey("9");
    dialKey("8");
    expect(document.querySelector("output")?.textContent).toBe("98");

    fireEvent.click(screen.getByTestId("phone-dial-backspace"));
    expect(document.querySelector("output")?.textContent).toBe("9");

    fireEvent.click(screen.getByTestId("phone-dial-backspace"));
    expect(screen.getByText("Enter a number")).toBeTruthy();
    expect(
      (screen.getByTestId("phone-dial-backspace") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("phone-dial-call") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("renders the call error text when the native bridge rejects", async () => {
    phoneBridge.placeCall.mockRejectedValue(new Error("CALL_PHONE denied"));
    render(React.createElement(PhoneAppView, overlayContext()));
    dialKey("1");
    fireEvent.click(screen.getByTestId("phone-dial-call"));
    await screen.findByText("CALL_PHONE denied");
    expect(phoneBridge.placeCall).toHaveBeenCalledWith({ number: "1" });
  });
});

describe("PhoneAppView — recent tab", () => {
  it("lazy-loads on first activation and renders populated rows with values", async () => {
    render(React.createElement(PhoneAppView, overlayContext()));
    expect(phoneBridge.listRecentCalls).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Recent" }));

    await screen.findByText("Ada Lovelace");
    expect(phoneBridge.listRecentCalls).toHaveBeenCalledWith({ limit: 50 });
    // Named call shows its number; un-named missed call shows the raw number.
    expect(screen.getByText(/\+15550100/)).toBeTruthy();
    expect(screen.getByText("+15550200")).toBeTruthy();
    expect(screen.getByText("Grace Hopper")).toBeTruthy();

    // Distinct call-type icons render (incoming/missed/outgoing each lucide svg).
    expect(document.querySelectorAll("svg.lucide-phone-incoming").length).toBe(
      1,
    );
    expect(document.querySelectorAll("svg.lucide-phone-missed").length).toBe(1);
    expect(document.querySelectorAll("svg.lucide-phone-outgoing").length).toBe(
      1,
    );
  });

  it("places a call to the entry number when a recent row is clicked", async () => {
    render(React.createElement(PhoneAppView, overlayContext()));
    fireEvent.click(screen.getByRole("tab", { name: "Recent" }));
    const adaRow = await screen.findByText("Ada Lovelace");
    fireEvent.click(adaRow.closest("button") as HTMLButtonElement);
    await waitFor(() =>
      expect(phoneBridge.placeCall).toHaveBeenCalledWith({
        number: "+15550100",
      }),
    );
  });

  it("re-fetches when the header Refresh button is pressed", async () => {
    render(React.createElement(PhoneAppView, overlayContext()));
    fireEvent.click(screen.getByRole("tab", { name: "Recent" }));
    await screen.findByText("Ada Lovelace");
    expect(phoneBridge.listRecentCalls).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(phoneBridge.listRecentCalls).toHaveBeenCalledTimes(2),
    );
  });

  it("shows the empty state with Dialer + Refresh actions and switches tabs", async () => {
    phoneBridge.listRecentCalls.mockResolvedValue({ calls: [] });
    render(React.createElement(PhoneAppView, overlayContext()));
    fireEvent.click(screen.getByRole("tab", { name: "Recent" }));

    // Empty-state body carries its own non-tab "Dialer" + "Refresh" actions.
    // Retry the locate+click through the re-fetch flicker until the dialer
    // pane (placeholder) reappears, proving the empty Dialer button switches
    // the active tab.
    await waitFor(
      () => {
        const emptyDialer = Array.from(
          document.querySelectorAll("button"),
        ).find(
          (b) =>
            b.getAttribute("role") !== "tab" &&
            b.textContent?.trim() === "Dialer",
        ) as HTMLButtonElement | undefined;
        expect(emptyDialer).toBeTruthy();
        const emptyRefresh = Array.from(
          document.querySelectorAll("button"),
        ).find(
          (b) =>
            b.getAttribute("role") !== "tab" &&
            b.textContent?.trim() === "Refresh",
        ) as HTMLButtonElement | undefined;
        expect(emptyRefresh).toBeTruthy();
        fireEvent.click(emptyDialer as HTMLButtonElement);
      },
      { timeout: 3000 },
    );
    await screen.findByText("Enter a number");
  });

  it("renders the error banner when the call-log fetch rejects", async () => {
    phoneBridge.listRecentCalls.mockRejectedValue(
      new Error("READ_CALL_LOG denied"),
    );
    render(React.createElement(PhoneAppView, overlayContext()));
    fireEvent.click(screen.getByRole("tab", { name: "Recent" }));
    await screen.findByText("READ_CALL_LOG denied");
  });
});

describe("PhoneAppView — contacts link", () => {
  it("exposes only Dialer + Recent tabs (no embedded Contacts tab)", () => {
    render(React.createElement(PhoneAppView, overlayContext()));
    expect(screen.getByRole("tab", { name: "Dialer" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Recent" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Contacts" })).toBeNull();
  });

  it("navigates to the Contacts view via the eliza:navigate:view bus", () => {
    render(React.createElement(PhoneAppView, overlayContext()));
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("eliza:navigate:view", listener);
    try {
      fireEvent.click(screen.getByTestId("phone-open-contacts"));
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

describe("PhoneAppView — header", () => {
  it("invokes exitToApps from the Back button", () => {
    const exit = vi.fn();
    render(React.createElement(PhoneAppView, overlayContext(exit)));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("only shows the header Refresh control on the Recent tab", async () => {
    render(React.createElement(PhoneAppView, overlayContext()));
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Recent" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy(),
    );
  });
});

// The xr surface registers the same PhonePluginView component under viewType
// "xr"; assert the populated dialer/recent path works identically there.
describe("PhonePluginView (xr/default wrapper)", () => {
  it("mounts and drives the dialer the same as the gui surface", async () => {
    render(React.createElement(PhonePluginView));
    dialKey("7");
    expect(document.querySelector("output")?.textContent).toBe("7");
    fireEvent.click(screen.getByTestId("phone-dial-call"));
    await waitFor(() =>
      expect(phoneBridge.placeCall).toHaveBeenCalledWith({ number: "7" }),
    );
  });
});
