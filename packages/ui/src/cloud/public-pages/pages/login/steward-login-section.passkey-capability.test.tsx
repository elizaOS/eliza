// @vitest-environment jsdom

/**
 * Login-page coverage for the passkey capability gate. The Steward SDK and
 * capability probe are doubled so the tests can assert the rendered branches
 * deterministically without invoking browser WebAuthn.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capabilityRef = vi.hoisted(() => ({
  usable: false,
  reason: "native-without-bridge" as "native-without-bridge" | "available",
}));

vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: () => Promise.resolve(capabilityRef),
}));

const stewardAuthSpies = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getSession: vi.fn(),
  refreshSession: vi.fn(),
  signInWithEmail: vi.fn(),
  signInWithPasskey: vi.fn(),
}));

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class {
    getProviders = stewardAuthSpies.getProviders;
    getSession = stewardAuthSpies.getSession;
    refreshSession = stewardAuthSpies.refreshSession;
    signInWithEmail = stewardAuthSpies.signInWithEmail;
    signInWithPasskey = stewardAuthSpies.signInWithPasskey;
  },
}));

vi.mock("../../../shell/steward-url", () => ({
  resolveBrowserStewardApiUrl: () => "https://api.example.test",
}));

vi.mock("../../../shell/steward-config", () => ({
  configuredStewardTenantId: () => "elizacloud",
  DEFAULT_STEWARD_TENANT_ID: "elizacloud",
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => false,
  consumeStewardCodeFromQuery: () => null,
  consumeStewardTokensFromHash: () => null,
  exchangeStewardCodeViaApi: vi.fn(),
  refreshStewardSessionViaCookie: vi.fn(),
  syncStewardSessionCookie: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/dashboard",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

import StewardLoginSection from "./steward-login-section";

function renderSection() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

function defaultProviders() {
  return {
    passkey: true,
    email: true,
    siwe: false,
    siws: false,
    google: true,
    discord: true,
    github: false,
    twitter: false,
    oauth: ["google", "discord"],
  };
}

describe("StewardLoginSection passkey capability gating", () => {
  beforeEach(() => {
    capabilityRef.usable = false;
    capabilityRef.reason = "native-without-bridge";
    stewardAuthSpies.getProviders.mockResolvedValue(defaultProviders());
    stewardAuthSpies.getSession.mockReturnValue(null);
    stewardAuthSpies.refreshSession.mockResolvedValue(null);
    stewardAuthSpies.signInWithEmail.mockResolvedValue(undefined);
    stewardAuthSpies.signInWithPasskey.mockResolvedValue({
      token: "session-token",
      refreshToken: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("hides passkey, omits webauthn autocomplete, and routes Enter to Magic Link when unsupported", async () => {
    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    expect(input.getAttribute("autocomplete")).toBe("email");
    expect(screen.queryByRole("button", { name: /Passkey/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Magic Link/i })).toBeTruthy();
    expect(
      screen.getByText(
        "Passkey sign-in is not available here. Use Google, Discord, or Magic Link, or open this sign-in link on another device.",
      ),
    ).toBeTruthy();

    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(stewardAuthSpies.signInWithEmail).toHaveBeenCalledWith(
        "person@example.com",
      ),
    );
    expect(stewardAuthSpies.signInWithPasskey).not.toHaveBeenCalled();
  });

  it("renders passkey and webauthn autocomplete after a positive capability probe", async () => {
    capabilityRef.usable = true;
    capabilityRef.reason = "available";

    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    expect(input.getAttribute("autocomplete")).toBe("email webauthn");
    expect(screen.getByRole("button", { name: /Passkey/i })).toBeTruthy();

    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Passkey/i }));

    await waitFor(() =>
      expect(stewardAuthSpies.signInWithPasskey).toHaveBeenCalledWith(
        "person@example.com",
      ),
    );
    expect(stewardAuthSpies.signInWithEmail).not.toHaveBeenCalled();
  });
});
