// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The banner reads app state via useAppSelectorShallow(selector); the mock runs
// the selector against a per-test fake state object.
const store = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("../../state", () => ({
  useAppSelectorShallow: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(store.current),
}));

import { ConnectionFailedBanner } from "./ConnectionFailedBanner";

function setStore(partial: Record<string, unknown>) {
  store.current = {
    t: (key: string) => key,
    backendConnection: null,
    backendDisconnectedBannerDismissed: false,
    dismissBackendDisconnectedBanner: vi.fn(),
    retryBackendConnection: vi.fn(),
    ...partial,
  };
}

const reconnecting = {
  state: "reconnecting",
  reconnectAttempt: 3,
  maxReconnectAttempts: 15,
  showDisconnectedUI: false,
};

const failed = {
  state: "failed",
  reconnectAttempt: 15,
  maxReconnectAttempts: 15,
  showDisconnectedUI: false,
};

describe("ConnectionFailedBanner", () => {
  beforeEach(() => setStore({}));

  it("renders the reconnecting indicator as an out-of-flow overlay (no layout shift)", () => {
    setStore({ backendConnection: reconnecting });
    const { container } = render(<ConnectionFailedBanner />);

    // The rendered root is the overlay wrapper; the pill is its only child.
    const overlay = container.firstElementChild as HTMLElement;
    const pill = overlay.firstElementChild as HTMLElement;

    // Overlay wrapper is absolutely positioned and click-through, so mounting
    // it consumes no layout height and never reflows the content below it.
    expect(overlay.className).toContain("absolute");
    expect(overlay.className).toContain("pointer-events-none");
    // Regression guard: it must NOT be an in-flow flex item any more.
    expect(overlay.className).not.toContain("shrink-0");
    expect(pill.className).not.toContain("shrink-0");
    expect(pill.getAttribute("role")).toBe("status");
  });

  it("shows the reconnect attempt counter", () => {
    setStore({ backendConnection: reconnecting });
    const { container } = render(<ConnectionFailedBanner />);
    expect(container.textContent).toContain("3/15");
  });

  it("keeps the failed 'connection lost' alert in document flow with actions", () => {
    setStore({ backendConnection: failed });
    render(<ConnectionFailedBanner />);

    const alert = screen.getByRole("alert");
    // Persistent, actionable state stays in-flow (shrink-0 flex item), not an
    // overlay — the user must act on it.
    expect(alert.className).toContain("shrink-0");
    expect(alert.className).not.toContain("absolute");
    expect(screen.getByText("common.dismiss")).toBeTruthy();
    expect(screen.getByText("vectorbrowserview.RetryConnection")).toBeTruthy();
  });

  it("hides the failed alert once dismissed", () => {
    setStore({
      backendConnection: failed,
      backendDisconnectedBannerDismissed: true,
    });
    const { container } = render(<ConnectionFailedBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while the full-screen disconnected UI is showing", () => {
    setStore({
      backendConnection: { ...reconnecting, showDisconnectedUI: true },
    });
    const { container } = render(<ConnectionFailedBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there is no backend connection state", () => {
    setStore({ backendConnection: null });
    const { container } = render(<ConnectionFailedBanner />);
    expect(container.firstChild).toBeNull();
  });
});
