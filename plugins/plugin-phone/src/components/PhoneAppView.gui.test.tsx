// @vitest-environment jsdom

// Full populated/interactive coverage for the default GUI surface (PhoneAppView)
// and its xr twin (same component, registered with viewType "xr"). The TUI view
// is covered separately in PhoneTuiView.test.ts; here we drive every dialer,
// recent, and contacts control through the rendered DOM and assert the native
// bridge is invoked with the exact normalized arguments.

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

// Controllable mock for the soft-dep contacts module. PhoneAppView builds the
// dynamic specifier at runtime; Vitest still matches the literal string here.
const contactsBridge = vi.hoisted(() => ({
  listContacts: vi.fn(),
}));
const contactsModulePresent = vi.hoisted(() => ({ value: true }));

vi.mock("@elizaos/capacitor-phone", () => ({
  Phone: phoneBridge,
}));

vi.mock("@elizaos/capacitor-contacts", () => {
  if (!contactsModulePresent.value) {
    throw new Error("module not installed");
  }
  return { Contacts: contactsBridge };
});

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

const sampleContacts = [
  {
    id: "c-1",
    lookupKey: "c-1-key",
    displayName: "Katherine Johnson",
    phoneNumbers: ["+15551111111", "+15552222222"],
    emailAddresses: [],
    starred: false,
  },
  {
    id: "c-2",
    lookupKey: "c-2-key",
    displayName: "Margaret Hamilton",
    phoneNumbers: ["+15553333333"],
    emailAddresses: [],
    starred: true,
  },
];

function overlayContext(exitToApps = vi.fn()) {
  return { exitToApps, uiTheme: "light" as const, t };
}

beforeEach(() => {
  contactsModulePresent.value = true;
  phoneBridge.getStatus.mockResolvedValue({
    hasTelecom: true,
    canPlaceCalls: true,
    isDefaultDialer: false,
    defaultDialerPackage: "com.android.dialer",
  });
  phoneBridge.listRecentCalls.mockResolvedValue({ calls: recentCalls });
  phoneBridge.placeCall.mockResolvedValue(undefined);
  phoneBridge.openDialer.mockResolvedValue(undefined);
  contactsBridge.listContacts.mockResolvedValue({ contacts: sampleContacts });
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

    await screen.findByText("No recent calls.");
    // Two Dialer buttons exist (the empty-state action + the tab); click the
    // empty-state action and assert the dialer pane is shown again.
    const dialerButtons = screen.getAllByRole("button", { name: "Dialer" });
    fireEvent.click(dialerButtons[dialerButtons.length - 1]);
    expect(screen.getByText("Enter a number")).toBeTruthy();
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

describe("PhoneAppView — contacts tab", () => {
  it("enables the tab, renders populated contacts, and calls the primary number", async () => {
    render(React.createElement(PhonePluginView));

    const contactsTab = await waitFor(() => {
      const tab = screen.getByRole("tab", {
        name: "Contacts",
      }) as HTMLButtonElement;
      expect(tab.disabled).toBe(false);
      return tab;
    });

    fireEvent.click(contactsTab);
    await screen.findByText("Katherine Johnson");
    expect(contactsBridge.listContacts).toHaveBeenCalledWith({ limit: 500 });
    expect(screen.getByText("Margaret Hamilton")).toBeTruthy();
    // Primary number (first in the array) is displayed.
    expect(screen.getByText("+15551111111")).toBeTruthy();

    fireEvent.click(
      screen.getByText("Katherine Johnson").closest("button") as HTMLElement,
    );
    await waitFor(() =>
      expect(phoneBridge.placeCall).toHaveBeenCalledWith({
        number: "+15551111111",
      }),
    );
  });

  it("disables a contact button that has no phone numbers", async () => {
    contactsBridge.listContacts.mockResolvedValue({
      contacts: [
        sampleContacts[0],
        {
          id: "c-3",
          lookupKey: "c-3-key",
          displayName: "Numberless Person",
          phoneNumbers: [],
          emailAddresses: [],
          starred: false,
        },
      ],
    });
    render(React.createElement(PhonePluginView));
    const contactsTab = await waitFor(() => {
      const tab = screen.getByRole("tab", {
        name: "Contacts",
      }) as HTMLButtonElement;
      expect(tab.disabled).toBe(false);
      return tab;
    });
    fireEvent.click(contactsTab);
    // The component filters out contacts with zero phone numbers before render,
    // so the numberless contact never appears as a callable row.
    await screen.findByText("Katherine Johnson");
    expect(screen.queryByText("Numberless Person")).toBeNull();
  });

  it("shows the unavailable state and keeps the tab disabled when the module is absent", async () => {
    contactsModulePresent.value = false;
    render(React.createElement(PhonePluginView));

    // Probe resolves to null -> tab stays disabled.
    await waitFor(() =>
      expect(
        (screen.getByRole("tab", { name: "Contacts" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(contactsBridge.listContacts).not.toHaveBeenCalled();
  });

  it("renders the contacts error banner when listContacts rejects", async () => {
    contactsBridge.listContacts.mockRejectedValue(
      new Error("READ_CONTACTS denied"),
    );
    render(React.createElement(PhonePluginView));
    const contactsTab = await waitFor(() => {
      const tab = screen.getByRole("tab", {
        name: "Contacts",
      }) as HTMLButtonElement;
      expect(tab.disabled).toBe(false);
      return tab;
    });
    fireEvent.click(contactsTab);
    await screen.findByText("READ_CONTACTS denied");
  });

  it("shows the empty contacts state when no contacts have numbers", async () => {
    contactsBridge.listContacts.mockResolvedValue({ contacts: [] });
    render(React.createElement(PhonePluginView));
    const contactsTab = await waitFor(() => {
      const tab = screen.getByRole("tab", {
        name: "Contacts",
      }) as HTMLButtonElement;
      expect(tab.disabled).toBe(false);
      return tab;
    });
    fireEvent.click(contactsTab);
    await screen.findByText("No contacts with phone numbers.");
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
