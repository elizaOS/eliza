/**
 * Verifies the Cloud Account Settings adapter connects its mocked domain
 * surface to the real app-owned login callback contract.
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

describe("CloudAccountSection", () => {
  afterEach(() => {
    cleanup();
    appState.handleInteractiveCloudLogin.mockReset();
    appState.handleInteractiveCloudLogin.mockResolvedValue(undefined);
    appState.setActionNotice.mockReset();
    claimCloudLoginWindow.mockReset();
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
