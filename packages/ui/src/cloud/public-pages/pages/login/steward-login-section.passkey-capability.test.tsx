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
  sendEmailOtp: vi.fn(),
  verifyEmailOtp: vi.fn(),
  addPasskey: vi.fn(),
}));

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class {
    getProviders = stewardAuthSpies.getProviders;
    getSession = stewardAuthSpies.getSession;
    refreshSession = stewardAuthSpies.refreshSession;
    signInWithEmail = stewardAuthSpies.signInWithEmail;
    signInWithPasskey = stewardAuthSpies.signInWithPasskey;
    sendEmailOtp = stewardAuthSpies.sendEmailOtp;
    verifyEmailOtp = stewardAuthSpies.verifyEmailOtp;
    addPasskey = stewardAuthSpies.addPasskey;
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
    expect(screen.getByRole("button", { name: /Google/i })).toBeTruthy();
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

  it("requires an email before invoking passkey sign-in", async () => {
    capabilityRef.usable = true;
    capabilityRef.reason = "available";

    renderSection();

    const passkeyButton = await screen.findByRole("button", {
      name: /Passkey/i,
    });
    fireEvent.click(passkeyButton);

    expect(await screen.findByText("Enter your email first")).toBeTruthy();
    expect(stewardAuthSpies.signInWithPasskey).not.toHaveBeenCalled();
  });

  it("falls back to email-OTP passkey signup when passkey sign-in fails, then completes registration", async () => {
    capabilityRef.usable = true;
    capabilityRef.reason = "available";
    stewardAuthSpies.signInWithPasskey.mockRejectedValue(
      new Error("no credential for this email"),
    );
    stewardAuthSpies.sendEmailOtp.mockResolvedValue(undefined);
    stewardAuthSpies.verifyEmailOtp.mockResolvedValue({
      emailGrant: "grant-1",
    });
    stewardAuthSpies.addPasskey.mockResolvedValue({
      token: "registered-token",
      refreshToken: null,
    });

    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Passkey/i }));

    // Sign-in failure routes into the OTP signup step, not an error dead-end.
    expect(await screen.findByText("Set up your passkey")).toBeTruthy();
    await waitFor(() =>
      expect(stewardAuthSpies.sendEmailOtp).toHaveBeenCalledWith(
        "person@example.com",
      ),
    );

    const codeInput = screen.getByPlaceholderText("123456");
    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Create passkey/i }));

    await waitFor(() =>
      expect(stewardAuthSpies.verifyEmailOtp).toHaveBeenCalledWith(
        "person@example.com",
        "123456",
      ),
    );
    await waitFor(() =>
      expect(stewardAuthSpies.addPasskey).toHaveBeenCalledWith(
        "person@example.com",
        { emailGrant: "grant-1" },
      ),
    );
  });

  it("rejects a too-short OTP code without calling the API and reports a cancelled passkey setup", async () => {
    capabilityRef.usable = true;
    capabilityRef.reason = "available";
    stewardAuthSpies.signInWithPasskey.mockRejectedValue(
      new Error("no credential"),
    );
    stewardAuthSpies.sendEmailOtp.mockResolvedValue(undefined);
    stewardAuthSpies.verifyEmailOtp.mockResolvedValue({
      emailGrant: "grant-1",
    });
    stewardAuthSpies.addPasskey.mockRejectedValue(
      new Error("NotAllowedError: the operation was aborted"),
    );

    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Passkey/i }));

    const codeInput = await screen.findByPlaceholderText("123456");

    // A short code is refused locally — Enter submits, but nothing hits the API.
    fireEvent.change(codeInput, { target: { value: "12" } });
    fireEvent.keyDown(codeInput, { key: "Enter" });
    expect(
      await screen.findByText("Enter the code from your email"),
    ).toBeTruthy();
    expect(stewardAuthSpies.verifyEmailOtp).not.toHaveBeenCalled();

    // A user-cancelled WebAuthn ceremony surfaces retry guidance, not a raw error.
    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Create passkey/i }));
    expect(
      await screen.findByText(
        "Passkey setup was cancelled. Tap Create passkey to retry.",
      ),
    ).toBeTruthy();
  });

  it("requires an email before sending a magic link and surfaces send failures", async () => {
    stewardAuthSpies.signInWithEmail.mockRejectedValue(
      new Error("SMTP unavailable"),
    );

    renderSection();

    const magicLink = await screen.findByRole("button", {
      name: /Magic Link/i,
    });
    fireEvent.click(magicLink);
    expect(await screen.findByText("Enter your email")).toBeTruthy();
    expect(stewardAuthSpies.signInWithEmail).not.toHaveBeenCalled();

    const input = screen.getByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(magicLink);
    expect(await screen.findByText("SMTP unavailable")).toBeTruthy();
  });

  it("renders the magic-link sent state and returns to the login form", async () => {
    stewardAuthSpies.signInWithEmail.mockResolvedValue(undefined);

    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Magic Link/i }));

    expect(await screen.findByText("Magic link sent to")).toBeTruthy();
    expect(screen.getByText("person@example.com")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Back to login/i }));
    expect(await screen.findByPlaceholderText("you@example.com")).toBeTruthy();
  });
});
