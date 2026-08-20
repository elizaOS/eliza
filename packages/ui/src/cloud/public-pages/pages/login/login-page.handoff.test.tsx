/**
 * Managed-cloud login handoff tests use a deterministic jsdom navigation
 * boundary to prove the transient bridge screen always falls back to a usable
 * Steward login when initiation is blocked, rejected, or never navigates.
 */
// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://agent-1.cloud.eliza.app/login?intent=launch"}

import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  redirect: vi.fn<() => Promise<boolean>>(),
  shouldAutoBridge: vi.fn<() => boolean>(),
}));

vi.mock("../../../sso-bridge/sso-bridge", () => ({
  redirectToSsoBridge: bridge.redirect,
  sanitizeBridgeReturnTo: (value: string | null) => value ?? "/",
  shouldAutoBridgeToSso: bridge.shouldAutoBridge,
}));

vi.mock("./steward-login-section", () => ({
  default: () => <div>Steward login options</div>,
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

import LoginPage from "./login-page";

async function renderLogin(): Promise<void> {
  await act(async () => {
    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/login?intent=launch"]}>
          <LoginPage />
        </MemoryRouter>
      </StrictMode>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  bridge.redirect.mockReset();
  bridge.shouldAutoBridge.mockReset();
  bridge.shouldAutoBridge.mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("managed-cloud login handoff", () => {
  it("renders one stable local sign-in surface when there is no auth-origin session to bridge", async () => {
    bridge.shouldAutoBridge.mockReturnValue(false);

    await renderLogin();

    expect(bridge.redirect).not.toHaveBeenCalled();
    expect(screen.queryByText("Taking you to Eliza sign in")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Sign in to Eliza" }),
    ).toBeTruthy();
  });

  it("starts one handoff under StrictMode when an existing session is bridgeable", async () => {
    bridge.redirect.mockResolvedValue(true);

    await renderLogin();

    expect(bridge.shouldAutoBridge).toHaveBeenCalledTimes(2);
    expect(bridge.redirect).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Taking you to Eliza sign in")).toBeTruthy();
  });

  it("falls back when bridge initiation rejects", async () => {
    bridge.redirect.mockRejectedValue(new Error("navigation unavailable"));

    await renderLogin();

    expect(
      screen.getByRole("heading", { name: "Sign in to Eliza" }),
    ).toBeTruthy();
  });

  it("leaves the transient screen after a bounded stalled navigation", async () => {
    bridge.redirect.mockResolvedValue(true);

    await renderLogin();
    expect(screen.getByText("Taking you to Eliza sign in")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(bridge.redirect).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("heading", { name: "Sign in to Eliza" }),
    ).toBeTruthy();
  });
});
