// @vitest-environment jsdom
//
// Component coverage for VincentConnectionCard — the OAuth connect/disconnect
// card. Drives the real useVincentState hook (which calls vincentClient +
// openExternalUrl), so we mock ./client and @elizaos/ui. Covers:
//   - disconnected: "Offline" + "Ready" chips, Connect button
//   - Connect -> vincentStartLogin("Eliza") + openExternalUrl(authUrl) +
//     Connecting…/disabled busy state
//   - connected: "Connected" chip + formatConnectedAt(ts) timestamp
//   - Disconnect -> vincentDisconnect + setActionNotice
//   - login error -> error banner text

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const vincentClientMock = vi.hoisted(() => ({
  vincentStatus: vi.fn(),
  vincentStartLogin: vi.fn(),
  vincentDisconnect: vi.fn(),
}));
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@elizaos/ui", () => ({
  openExternalUrl: openExternalUrlMock,
  Button: React.forwardRef<HTMLButtonElement, Record<string, unknown>>(
    function MockButton({ children, ...props }, ref) {
      return React.createElement(
        "button",
        { type: "button", ref, ...props },
        children as React.ReactNode,
      );
    },
  ),
  StatusDot: () => React.createElement("span", { "data-testid": "status-dot" }),
}));

vi.mock("./client", () => ({ vincentClient: vincentClientMock }));

import { VincentConnectionCard } from "./VincentConnectionCard";

const t = (_key: string, opts?: { defaultValue?: string }) =>
  opts?.defaultValue ?? _key;

const CONNECTED_AT = 1_700_000_000_000; // 2023-11-14 (ms)

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VincentConnectionCard — disconnected", () => {
  it("renders the Offline/Ready chips and the Connect call-to-action", async () => {
    vincentClientMock.vincentStatus.mockResolvedValue({
      connected: false,
      connectedAt: null,
    });
    render(<VincentConnectionCard setActionNotice={vi.fn()} t={t} />);

    // Initial status poll resolves -> Offline.
    await waitFor(() => expect(screen.getByText("Offline")).toBeTruthy());
    // No connectedAt -> "Ready" placeholder chip.
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Connect Vincent")).toBeTruthy();
    expect(screen.queryByText("Disconnect")).toBeNull();
  });

  it("Connect starts OAuth: vincentStartLogin('Eliza') + openExternalUrl + Connecting… busy state", async () => {
    vincentClientMock.vincentStatus.mockResolvedValue({
      connected: false,
      connectedAt: null,
    });
    // Keep startLogin pending until we release it so the busy state is observable.
    let resolveLogin!: (v: {
      authUrl: string;
      state: string;
      redirectUri: string;
    }) => void;
    vincentClientMock.vincentStartLogin.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve;
      }),
    );
    render(<VincentConnectionCard setActionNotice={vi.fn()} t={t} />);
    await waitFor(() =>
      expect(screen.getByText("Connect Vincent")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("Connect Vincent"));

    // Busy: button swaps to Connecting… and is disabled.
    await waitFor(() => expect(screen.getByText("Connecting…")).toBeTruthy());
    const busyBtn = screen.getByText("Connecting…").closest("button");
    expect(busyBtn?.hasAttribute("disabled")).toBe(true);
    expect(vincentClientMock.vincentStartLogin).toHaveBeenCalledWith("Eliza");

    // Release startLogin -> the auth URL is opened in the external browser.
    resolveLogin({
      authUrl: "https://heyvincent.ai/api/oauth/public/authorize?client_id=x",
      state: "state-1",
      redirectUri: "http://localhost/callback/vincent",
    });
    await waitFor(() =>
      expect(openExternalUrlMock).toHaveBeenCalledWith(
        "https://heyvincent.ai/api/oauth/public/authorize?client_id=x",
      ),
    );
  });

  it("surfaces a login error banner when vincentStartLogin rejects", async () => {
    vincentClientMock.vincentStatus.mockResolvedValue({
      connected: false,
      connectedAt: null,
    });
    vincentClientMock.vincentStartLogin.mockRejectedValue(
      new Error("Vincent register failed: 503"),
    );
    render(<VincentConnectionCard setActionNotice={vi.fn()} t={t} />);
    await waitFor(() =>
      expect(screen.getByText("Connect Vincent")).toBeTruthy(),
    );

    fireEvent.click(screen.getByText("Connect Vincent"));

    await waitFor(() =>
      expect(screen.getByText("Vincent register failed: 503")).toBeTruthy(),
    );
    expect(openExternalUrlMock).not.toHaveBeenCalled();
  });
});

describe("VincentConnectionCard — connected", () => {
  it("renders the Connected chip + formatted connectedAt and disconnects on click", async () => {
    vincentClientMock.vincentStatus.mockResolvedValue({
      connected: true,
      connectedAt: CONNECTED_AT,
    });
    vincentClientMock.vincentDisconnect.mockResolvedValue({ ok: true });
    const setActionNotice = vi.fn();
    render(<VincentConnectionCard setActionNotice={setActionNotice} t={t} />);

    // Connected chip appears once the initial poll resolves.
    await waitFor(() => expect(screen.getByText("Connected")).toBeTruthy());

    // The connectedAt chip renders the locale-formatted timestamp (not "Ready").
    const expected = new Date(CONNECTED_AT).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.queryByText("Ready")).toBeNull();

    // Disconnect button is shown; clicking it calls vincentDisconnect + notice.
    fireEvent.click(screen.getByText("Disconnect"));
    await waitFor(() =>
      expect(vincentClientMock.vincentDisconnect).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith(
        "Vincent disconnected",
        "info",
        3000,
      ),
    );
    // After disconnect the card flips back to the Connect CTA.
    await waitFor(() => expect(screen.getByText("Offline")).toBeTruthy());
  });
});
