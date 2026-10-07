/**
 * Verifies the Cloud Account Settings adapter connects its mocked domain
 * surface to the real app-owned login callback contract.
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
      elizaCloudLoginBusy: false,
      handleInteractiveCloudLogin: appState.handleInteractiveCloudLogin,
      setActionNotice: appState.setActionNotice,
      t: (key, options) => options?.defaultValue ?? key,
    }),
}));

vi.mock("../../state/cloud-login-launch", () => ({
  claimCloudLoginWindow,
}));

vi.mock("../account-security/AccountSurface", () => ({
  AccountSurface: ({ onSignIn }: { onSignIn: () => void }) => (
    <button type="button" onClick={onSignIn}>
      Sign in through adapter
    </button>
  ),
}));

vi.mock("./CloudSettingsSectionShell", () => ({
  CloudSettingsSectionShell: ({ children }: { children: ReactNode }) =>
    children,
}));

import { CloudAccountSection } from "./sections";

function StandaloneAccountDestination(): React.JSX.Element {
  const location = useLocation();
  return <div>{`Standalone account${location.search}`}</div>;
}

describe("CloudAccountSection", () => {
  afterEach(() => {
    cleanup();
    setActiveSurfaceRealmScope(null);
    window.history.replaceState(null, "", "/");
    appState.handleInteractiveCloudLogin.mockReset();
    appState.handleInteractiveCloudLogin.mockResolvedValue(undefined);
    appState.setActionNotice.mockReset();
    claimCloudLoginWindow.mockReset();
  });

  it("leaves the hosted agent shell for the standalone account route", async () => {
    window.history.replaceState(
      null,
      "",
      "/settings?from=launcher#cloud-account",
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
                <CloudAccountSection />
              </>
            }
          />
          <Route
            path="/cloud/account"
            element={<StandaloneAccountDestination />}
          />
        </Routes>
      </BrowserRouter>,
    );

    expect(
      await screen.findByText("Standalone account?from=launcher"),
    ).toBeTruthy();
    expect(screen.queryByText("Message Eliza")).toBeNull();
    expect(window.location.pathname).toBe("/cloud/account");
    expect(window.location.search).toBe("?from=launcher");
    expect(window.location.hash).toBe("");
    expect(() =>
      window.history.replaceState(null, "", "/ungranted-view-route"),
    ).toThrow(SurfaceRealmDeniedError);
    expect(
      screen.queryByRole("button", { name: "Sign in through adapter" }),
    ).toBeNull();
  });

  it("uses the app-owned interactive Cloud login flow", () => {
    render(<CloudAccountSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Sign in through adapter" }),
    );

    expect(claimCloudLoginWindow).toHaveBeenCalledOnce();
    expect(appState.handleInteractiveCloudLogin).toHaveBeenCalledOnce();
  });

  it("surfaces an interactive login launch failure", async () => {
    appState.handleInteractiveCloudLogin.mockRejectedValue(
      new Error("Cloud login unavailable"),
    );
    render(<CloudAccountSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Sign in through adapter" }),
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
