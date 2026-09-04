/**
 * Verifies the Cloud Billing Settings adapter connects the billing sign-in
 * control to the app-owned interactive login flow and visible error boundary.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({
  loginBusy: false,
  handleInteractiveCloudLogin: vi.fn(() => Promise.resolve()),
  setActionNotice: vi.fn(),
}));
const claimCloudLoginWindow = vi.hoisted(() => vi.fn());

vi.mock("../../state", () => ({
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

describe("CloudBillingSection", () => {
  afterEach(() => {
    cleanup();
    appState.loginBusy = false;
    appState.handleInteractiveCloudLogin.mockReset();
    appState.handleInteractiveCloudLogin.mockResolvedValue(undefined);
    appState.setActionNotice.mockReset();
    claimCloudLoginWindow.mockReset();
  });

  it("claims a browser window before starting the app-owned login flow", () => {
    render(<CloudBillingSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Sign in through billing adapter" }),
    );

    expect(claimCloudLoginWindow).toHaveBeenCalledOnce();
    expect(appState.handleInteractiveCloudLogin).toHaveBeenCalledOnce();
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
