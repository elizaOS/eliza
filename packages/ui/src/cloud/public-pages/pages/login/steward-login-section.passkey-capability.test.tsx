/**
 * Login-page coverage for the passkey capability gate. The Steward SDK and
 * capability probe are deterministic doubles so the tests can assert explicit
 * recovery, hard-failure, and enrollment branches without invoking WebAuthn.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  signInWithPasskey: vi.fn(),
  sendEmailOtp: vi.fn(),
  verifyEmailOtp: vi.fn(),
  addPasskey: vi.fn(),
}));

const emailLoginSpies = vi.hoisted(() => ({
  start: vi.fn(),
  verify: vi.fn(),
  poll: vi.fn(),
}));

const sessionSpies = vi.hoisted(() => ({
  recover: vi.fn(),
  hasCookie: false,
}));

vi.mock("@elizaos/shared/steward-session-client", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@elizaos/shared/steward-session-client")
    >();
  return {
    ...actual,
    hasStewardAuthedCookie: () => sessionSpies.hasCookie,
  };
});

vi.mock("@stwd/sdk", () => ({
  StewardApiError: class StewardApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "StewardApiError";
      this.status = status;
    }
  },
  StewardAuth: class {
    getProviders = stewardAuthSpies.getProviders;
    getSession = stewardAuthSpies.getSession;
    refreshSession = stewardAuthSpies.refreshSession;
    signInWithPasskey = stewardAuthSpies.signInWithPasskey;
    sendEmailOtp = stewardAuthSpies.sendEmailOtp;
    verifyEmailOtp = stewardAuthSpies.verifyEmailOtp;
    addPasskey = stewardAuthSpies.addPasskey;
  },
}));

vi.mock("../../lib/steward-email-login", () => ({
  StewardEmailLoginError: class StewardEmailLoginError extends Error {
    status: number;
    code: string | null;
    constructor(message: string, status: number, code: string | null) {
      super(message);
      this.name = "StewardEmailLoginError";
      this.status = status;
      this.code = code;
    }
  },
  startStewardEmailLogin: emailLoginSpies.start,
  verifyStewardEmailSignInCode: emailLoginSpies.verify,
  pollStewardEmailSignInStatus: emailLoginSpies.poll,
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
  stripLegacyTokenHashFromAddressBar: () => false,
  exchangeStewardCodeViaApi: vi.fn(),
  recoverStewardSessionViaCookie: sessionSpies.recover,
  refreshStewardSessionViaCookie: vi.fn(),
  syncStewardSessionCookie: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/cloud",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

import { StewardApiError } from "@stwd/sdk";
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
    window.localStorage.clear();
    capabilityRef.usable = false;
    capabilityRef.reason = "native-without-bridge";
    stewardAuthSpies.getProviders.mockResolvedValue(defaultProviders());
    stewardAuthSpies.getSession.mockReturnValue(null);
    stewardAuthSpies.refreshSession.mockResolvedValue(null);
    stewardAuthSpies.sendEmailOtp.mockResolvedValue(undefined);
    emailLoginSpies.start.mockResolvedValue({
      expiresAt: "2026-07-17T12:10:00.000Z",
      challengeId: "challenge-1",
      pollSecret: "poll-secret",
    });
    emailLoginSpies.verify.mockResolvedValue({
      token: "email-token",
      refreshToken: null,
    });
    emailLoginSpies.poll.mockResolvedValue("pending");
    stewardAuthSpies.signInWithPasskey.mockResolvedValue({
      token: "session-token",
      refreshToken: null,
    });
    sessionSpies.recover.mockResolvedValue(null);
    sessionSpies.hasCookie = false;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("cleans a rejected cookie-only session and leaves a usable sign-in form", async () => {
    sessionSpies.hasCookie = true;

    renderSection();

    await waitFor(() => expect(sessionSpies.recover).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: /Google/i })).toBeTruthy();
    expect(screen.queryByText("Refresh token rejected")).toBeNull();
  });

  it("hides passkey, omits webauthn autocomplete, and routes Enter to Magic Link when unsupported", async () => {
    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    expect(input.getAttribute("autocomplete")).toBe("email");
    expect(screen.queryByRole("button", { name: /Passkey/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Magic Link/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Google/i })).toBeTruthy();
    // The passkey-unavailable banner must not appear when passkeys are
    // confirmed unsupported — the host should not mention passkeys at all
    // on screen 1 (#19217).
    expect(
      screen.queryByText(
        "Passkey sign-in is not available here. Use Google, Discord, or Magic Link, or open this sign-in link on another device.",
      ),
    ).toBeNull();

    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(emailLoginSpies.start).toHaveBeenCalledWith(
        { baseUrl: "https://api.example.test", tenantId: "elizacloud" },
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
        { fallbackToRegistration: false },
      ),
    );
    expect(emailLoginSpies.start).not.toHaveBeenCalled();
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

  it("offers recovery without sending mail, then enrolls only after explicit setup intent", async () => {
    capabilityRef.usable = true;
    capabilityRef.reason = "available";
    stewardAuthSpies.signInWithPasskey.mockRejectedValue(
      new StewardApiError(
        "WebAuthn authentication cancelled or failed: NotAllowedError",
        0,
      ),
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

    expect(await screen.findByText("Passkey not completed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use Magic Link" })).toBeTruthy();
    const setupButton = screen.getByRole("button", {
      name: "Set up passkey",
    });
    expect(setupButton).toBeTruthy();
    expect(stewardAuthSpies.sendEmailOtp).not.toHaveBeenCalled();
    expect(emailLoginSpies.start).not.toHaveBeenCalled();

    fireEvent.click(setupButton);

    expect(await screen.findByText("Set up your passkey")).toBeTruthy();
    expect(stewardAuthSpies.sendEmailOtp).toHaveBeenCalledWith(
      "person@example.com",
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

  it("starts Magic Link only after the user chooses that recovery action", async () => {
    capabilityRef.usable = true;
    capabilityRef.reason = "available";
    stewardAuthSpies.signInWithPasskey.mockRejectedValue(
      new StewardApiError("No passkey registered", 404),
    );

    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Passkey/i }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Use Magic Link" }),
    );

    await waitFor(() =>
      expect(emailLoginSpies.start).toHaveBeenCalledWith(
        { baseUrl: "https://api.example.test", tenantId: "elizacloud" },
        "person@example.com",
      ),
    );
    expect(stewardAuthSpies.sendEmailOtp).not.toHaveBeenCalled();
  });

  it("keeps a complete email focused after 404 passkey recovery", async () => {
    capabilityRef.usable = true;
    capabilityRef.reason = "available";
    stewardAuthSpies.signInWithPasskey.mockRejectedValue(
      new StewardApiError("No passkey registered", 404),
    );

    const user = userEvent.setup();
    renderSection();

    const input = (await screen.findByPlaceholderText(
      "you@example.com",
    )) as HTMLInputElement;
    await user.type(input, "first@example.com");
    await user.click(screen.getByRole("button", { name: /^Passkey$/i }));

    expect(await screen.findByText("Passkey not completed")).toBeTruthy();

    await user.clear(input);
    await user.type(input, "complete@example.com");

    expect(input.value).toBe("complete@example.com");
    expect(document.activeElement).toBe(input);
    expect(screen.getByText("Passkey not completed")).toBeTruthy();
  });

  it("surfaces UV error and does not enter passkey signup when sign-in fails with user-verification required", async () => {
    // Reproduces #18468: signInWithPasskey failing with a UV error was silently
    // swallowed by the bare catch, which called startPasskeySignup() instead —
    // sending the user a "Set up your passkey" OTP email and then hitting the
    // same UV constraint again during addPasskey().
    capabilityRef.usable = true;
    capabilityRef.reason = "available";
    stewardAuthSpies.signInWithPasskey.mockRejectedValue(
      new StewardApiError(
        "WebAuthn authentication cancelled or failed: User verification was required, but user could not be verified",
        0,
      ),
    );

    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Passkey/i }));

    // Error is surfaced; no OTP email is sent, no signup flow is entered.
    await waitFor(() =>
      expect(stewardAuthSpies.signInWithPasskey).toHaveBeenCalledWith(
        "person@example.com",
        { fallbackToRegistration: false },
      ),
    );
    expect(
      await screen.findByText(
        "Passkey sign-in requires device verification (PIN or biometric). Your device may not support this — try Magic Link instead.",
      ),
    ).toBeTruthy();
    expect(stewardAuthSpies.sendEmailOtp).not.toHaveBeenCalled();
    expect(screen.queryByText("Set up your passkey")).toBeNull();
    expect(screen.queryByText("Passkey not completed")).toBeNull();
  });

  it.each([
    new StewardApiError("Network request failed", 0),
    new StewardApiError("Passkey service unavailable", 500),
    new StewardApiError("User verification service unavailable", 500),
    new StewardApiError("Gateway timed out", 504),
  ])(
    "surfaces hard failure %s without recovery or enrollment",
    async (passkeyError) => {
      capabilityRef.usable = true;
      capabilityRef.reason = "available";
      stewardAuthSpies.signInWithPasskey.mockRejectedValue(passkeyError);

      renderSection();

      const input = await screen.findByPlaceholderText("you@example.com");
      fireEvent.change(input, { target: { value: "person@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: /Passkey/i }));

      expect(await screen.findByText(passkeyError.message)).toBeTruthy();
      expect(screen.queryByText("Passkey not completed")).toBeNull();
      expect(screen.queryByText("Set up your passkey")).toBeNull();
      expect(stewardAuthSpies.sendEmailOtp).not.toHaveBeenCalled();
      expect(emailLoginSpies.start).not.toHaveBeenCalled();
    },
  );

  it("clears recovery actions when a same-mount retry ends in a hard server failure", async () => {
    capabilityRef.usable = true;
    capabilityRef.reason = "available";
    stewardAuthSpies.signInWithPasskey
      .mockRejectedValueOnce(
        new StewardApiError(
          "WebAuthn authentication cancelled or failed: NotAllowedError",
          0,
        ),
      )
      .mockRejectedValueOnce(
        new StewardApiError("User verification service unavailable", 500),
      );

    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^Passkey$/i }));

    expect(await screen.findByText("Passkey not completed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use Magic Link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up passkey" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Passkey$/i }));

    expect(
      await screen.findByText("User verification service unavailable"),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("Passkey not completed")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Use Magic Link" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Set up passkey" }),
      ).toBeNull();
    });
    expect(stewardAuthSpies.signInWithPasskey).toHaveBeenCalledTimes(2);
    expect(stewardAuthSpies.sendEmailOtp).not.toHaveBeenCalled();
    expect(emailLoginSpies.start).not.toHaveBeenCalled();
  });

  it("surfaces MFA-required without recovery or enrollment", async () => {
    capabilityRef.usable = true;
    capabilityRef.reason = "available";
    stewardAuthSpies.signInWithPasskey.mockResolvedValue({
      mfaRequired: true,
      mfaToken: "mfa-token",
    });

    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Passkey/i }));

    expect(
      await screen.findByText(
        "MFA required. This client does not support it yet.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Passkey not completed")).toBeNull();
    expect(stewardAuthSpies.sendEmailOtp).not.toHaveBeenCalled();
  });

  it("rejects a too-short OTP code without calling the API and reports a cancelled passkey setup", async () => {
    capabilityRef.usable = true;
    capabilityRef.reason = "available";
    stewardAuthSpies.signInWithPasskey.mockRejectedValue(
      new StewardApiError(
        "WebAuthn authentication cancelled or failed: NotAllowedError",
        0,
      ),
    );
    stewardAuthSpies.sendEmailOtp.mockResolvedValue(undefined);
    stewardAuthSpies.verifyEmailOtp.mockResolvedValue({
      emailGrant: "grant-1",
    });
    stewardAuthSpies.addPasskey.mockRejectedValue(
      new StewardApiError(
        "WebAuthn registration cancelled or failed: NotAllowedError: the operation was aborted",
        0,
      ),
    );

    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Passkey/i }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Set up passkey" }),
    );

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
    emailLoginSpies.start.mockRejectedValue(new Error("SMTP unavailable"));

    renderSection();

    const magicLink = await screen.findByRole("button", {
      name: /Magic Link/i,
    });
    fireEvent.click(magicLink);
    expect(await screen.findByText("Enter your email")).toBeTruthy();
    expect(emailLoginSpies.start).not.toHaveBeenCalled();

    const input = screen.getByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(magicLink);
    expect(await screen.findByText("SMTP unavailable")).toBeTruthy();
  });

  it("renders the email code state and returns to the login form", async () => {
    renderSection();

    const input = await screen.findByPlaceholderText("you@example.com");
    fireEvent.change(input, { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Magic Link/i }));

    expect(await screen.findByText("Check your email")).toBeTruthy();
    expect(screen.getByText("person@example.com")).toBeTruthy();
    const codeInput = screen.getByLabelText("Six-digit code");
    expect(codeInput.getAttribute("inputmode")).toBe("numeric");
    expect(codeInput.getAttribute("autocomplete")).toBe("one-time-code");
    expect(codeInput.getAttribute("maxlength")).toBe("6");

    fireEvent.click(screen.getByRole("button", { name: /Back to login/i }));
    expect(await screen.findByPlaceholderText("you@example.com")).toBeTruthy();
  });
});
