// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendRow } from "./SecretsManagerSection";

afterEach(cleanup);

const noop = () => undefined;

const baseRowProps = {
  enabled: true,
  isPrimary: false,
  position: 1,
  totalEnabled: 2,
  methods: [],
  installSheetOpen: false,
  signinSheetOpen: false,
  onToggle: noop,
  onMoveUp: noop,
  onMoveDown: noop,
  onOpenInstallSheet: noop,
  onOpenSigninSheet: noop,
  onCloseSheets: noop,
  onInstallComplete: noop,
  onSigninComplete: noop,
  onSignout: noop,
};

describe("BackendRow — three external states", () => {
  it("renders an Install button when the backend is not available", () => {
    const onOpenInstallSheet = vi.fn();
    render(
      <BackendRow
        {...baseRowProps}
        backend={{
          id: "bitwarden",
          label: "Bitwarden",
          available: false,
          detail: "`bw` CLI not installed.",
        }}
        enabled={false}
        onOpenInstallSheet={onOpenInstallSheet}
      />,
    );
    const button = screen.getByRole("button", { name: /Install Bitwarden/i });
    expect(button).toBeTruthy();
    button.click();
    expect(onOpenInstallSheet).toHaveBeenCalledTimes(1);
    // No reorder buttons in not-available state.
    expect(screen.queryByRole("button", { name: /Move up/i })).toBeNull();
  });

  it("renders a Sign in button when the backend is detected but not signed in", () => {
    const onOpenSigninSheet = vi.fn();
    render(
      <BackendRow
        {...baseRowProps}
        backend={{
          id: "1password",
          label: "1Password",
          available: true,
          signedIn: false,
          detail: "`op` is installed but not signed in.",
        }}
        onOpenSigninSheet={onOpenSigninSheet}
      />,
    );
    const button = screen.getByRole("button", {
      name: /Sign in to 1Password/i,
    });
    expect(button).toBeTruthy();
    button.click();
    expect(onOpenSigninSheet).toHaveBeenCalledTimes(1);
  });

  it("renders Sign out + reorder when the backend is signed in", () => {
    const onSignout = vi.fn();
    render(
      <BackendRow
        {...baseRowProps}
        backend={{
          id: "1password",
          label: "1Password",
          available: true,
          signedIn: true,
        }}
        position={0}
        totalEnabled={2}
        onSignout={onSignout}
      />,
    );
    const signOut = screen.getByRole("button", {
      name: /Sign out of 1Password/i,
    });
    expect(signOut).toBeTruthy();
    signOut.click();
    expect(onSignout).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Move up/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Move down/i })).toBeTruthy();
  });

  it("does not show install/signin buttons for the in-house backend", () => {
    render(
      <BackendRow
        {...baseRowProps}
        backend={{
          id: "in-house",
          label: "Milady (local, encrypted)",
          available: true,
          signedIn: true,
        }}
        position={0}
      />,
    );
    expect(screen.queryByRole("button", { name: /Install/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign in/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign out/i })).toBeNull();
  });

  it("renders the inline install sheet when installSheetOpen", () => {
    render(
      <BackendRow
        {...baseRowProps}
        backend={{
          id: "bitwarden",
          label: "Bitwarden",
          available: false,
        }}
        enabled={false}
        installSheetOpen={true}
        methods={[
          { kind: "brew", package: "bitwarden-cli", cask: false },
          { kind: "npm", package: "@bitwarden/cli" },
        ]}
      />,
    );
    expect(screen.getByText(/brew install bitwarden-cli/i)).toBeTruthy();
    expect(screen.getByText(/npm install -g @bitwarden\/cli/i)).toBeTruthy();
  });

  it("renders the inline sign-in form when signinSheetOpen for 1Password", () => {
    render(
      <BackendRow
        {...baseRowProps}
        backend={{
          id: "1password",
          label: "1Password",
          available: true,
          signedIn: false,
        }}
        signinSheetOpen={true}
      />,
    );
    expect(screen.getByLabelText(/Email/i)).toBeTruthy();
    expect(screen.getByLabelText(/Secret key/i)).toBeTruthy();
    expect(screen.getByLabelText(/Master password/i)).toBeTruthy();
    // The master password input is type=password.
    const pwd = screen.getByLabelText(/Master password/i);
    expect((pwd as HTMLInputElement).type).toBe("password");
  });
});
