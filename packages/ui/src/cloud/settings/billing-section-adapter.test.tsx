/**
 * Verifies the Cloud Billing Settings adapter connects the billing sign-in
 * control to the app-owned interactive login flow and visible error boundary.
 */
// @vitest-environment jsdom

import { resolveSurfaceManifest } from "@elizaos/core/protocol";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SurfaceRealmDeniedError,
  SurfaceRealmScope,
  setActiveSurfaceRealmScope,
} from "../../surface-realm-broker";

const appState = vi.hoisted(() => ({
  loginBusy: false,
  handleInteractiveCloudLogin: vi.fn(() => Promise.resolve()),
  setActionNotice: vi.fn(),
}));
const claimCloudLoginWindow = vi.hoisted(() => vi.fn());

vi.mock("../../state/app-store", () => ({
  useAppSelectorShallow: (
    selector: (state: {
      elizaCloudLoginBusy: boolean;
      handleInteractiveCloudLogin: typeof appState.handleInteractiveCloudLogin;
      setActionNotice: typeof appState.setActionNotice;
      t: (key: string, options?: { defaultValue?: string }) => string;
    }) => unknown,
  ) =>
    selector({
      elizaCloudLoginBusy: appState.loginBusy,
      handleInteractiveCloudLogin: appState.handleInteractiveCloudLogin,
      setActionNotice: appState.setActionNotice,
      t: (key, options) => options?.defaultValue ?? key,
    }),
}));

vi.mock("../../state/cloud-login-launch", () => ({
  claimCloudLoginWindow,
}));

vi.mock("../billing/BillingSection", () => ({
  BillingSectionBody: ({
    onSignIn,
    signInBusy,
  }: {
    onSignIn: () => void;
    signInBusy: boolean;
  }) => (
    <button type="button" onClick={onSignIn} disabled={signInBusy}>
      Sign in through billing adapter
    </button>
  ),
}));

vi.mock("./CloudSettingsSectionShell", () => ({
  CloudSettingsSectionShell: ({ children }: { children: ReactNode }) =>
    children,
}));

import { CloudBillingSection } from "./sections";

function StandaloneBillingDestination(): React.JSX.Element {
  const location = useLocation();
  return <div>{`Standalone billing${location.search}`}</div>;
}

describe("CloudBillingSection", () => {
  afterEach(() => {
    cleanup();
    setActiveSurfaceRealmScope(null);
    window.history.replaceState(null, "", "/");
    appState.loginBusy = false;
    appState.handleInteractiveCloudLogin.mockReset();
    appState.handleInteractiveCloudLogin.mockResolvedValue(undefined);
    appState.setActionNotice.mockReset();
    claimCloudLoginWindow.mockReset();
  });

  it("leaves the hosted agent shell for the standalone billing route", async () => {
    window.history.replaceState(
      null,
      "",
      "/settings?from=launcher#cloud-billing",
    );
    setActiveSurfaceRealmScope(
      new SurfaceRealmScope(
        resolveSurfaceManifest({ surface: { capabilities: [] } }),
        "settings",
        window.localStorage,
        () => undefined,
      ),
    );
    render(
      <BrowserRouter>
        <Routes>
          <Route
            path="/settings"
            element={
              <>
                <div>Message Eliza</div>
                <CloudBillingSection />
              </>
            }
          />
          <Route
            path="/cloud/billing"
            element={<StandaloneBillingDestination />}
          />
        </Routes>
      </BrowserRouter>,
    );

    expect(
      await screen.findByText("Standalone billing?from=launcher"),
    ).toBeTruthy();
    expect(screen.queryByText("Message Eliza")).toBeNull();
    expect(window.location.pathname).toBe("/cloud/billing");
    expect(window.location.search).toBe("?from=launcher");
    expect(window.location.hash).toBe("");
    expect(() =>
      window.history.replaceState(null, "", "/ungranted-view-route"),
    ).toThrow(SurfaceRealmDeniedError);
    expect(
      screen.queryByRole("button", { name: "Sign in through billing adapter" }),
    ).toBeNull();
  });

  it("claims a browser window before starting the app-owned login flow", () => {
    render(<CloudBillingSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Sign in through billing adapter" }),
    );

    expect(claimCloudLoginWindow).toHaveBeenCalledOnce();
    expect(
      appState.handleInteractiveCloudLogin,
    ).toHaveBeenCalledExactlyOnceWith({
      requireClientAuth: true,
      forceReauth: true,
    });
  });

  it("passes the app login busy state to the billing control", () => {
    appState.loginBusy = true;
    render(<CloudBillingSection />);

    expect(
      screen.getByRole("button", { name: "Sign in through billing adapter" }),
    ).toHaveProperty("disabled", true);
  });

  it("surfaces an interactive login launch failure", async () => {
    appState.handleInteractiveCloudLogin.mockRejectedValue(
      new Error("Cloud login unavailable"),
    );
    render(<CloudBillingSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Sign in through billing adapter" }),
    );

    await waitFor(() => {
      expect(appState.setActionNotice).toHaveBeenCalledWith(
        "Cloud login unavailable",
        "error",
        5000,
      );
    });
  });
});
