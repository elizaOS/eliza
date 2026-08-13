/** Verifies StewardLoginSection wallet-method collapse (#19217). */
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  consumeStewardTokensFromHash: () => null,
  exchangeStewardCodeViaApi: vi.fn(),
  recoverStewardSessionViaCookie: sessionSpies.recover,
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

function walletProviders() {
  return {
    passkey: true,
    email: true,
    siwe: true,
    siws: true,
    google: false,
    discord: false,
    github: false,
    twitter: false,
    oauth: [],
  };
}

describe("StewardLoginSection wallet collapse (#19217)", () => {
  beforeEach(() => {
    capabilityRef.usable = false;
    capabilityRef.reason = "native-without-bridge";
    stewardAuthSpies.getProviders.mockResolvedValue(walletProviders());
    stewardAuthSpies.getSession.mockReturnValue(null);
    stewardAuthSpies.refreshSession.mockResolvedValue(null);
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

  it("collapses wallet methods behind a single toggle and expands on click", async () => {
    renderSection();

    // Wait for provider discovery to settle, then the collapsed toggle appears.
    const walletToggle = await screen.findByRole("button", {
      name: /Continue with a wallet/i,
    });

    // Disclosure semantics: collapsed state has aria-expanded=false.
    expect(walletToggle.getAttribute("aria-expanded")).toBe("false");
    expect(walletToggle.getAttribute("aria-controls")).toBe(
      "steward-wallet-options",
    );

    // Wallet peer buttons must NOT be visible until the user expands.
    expect(screen.queryByText("EVM wallet")).toBeNull();
    expect(screen.queryByText("Solana wallet")).toBeNull();

    // Expanding reveals the individual wallet buttons.
    fireEvent.click(walletToggle);
    expect(await screen.findByText("EVM wallet")).toBeTruthy();
    expect(screen.getByText("Solana wallet")).toBeTruthy();

    // The toggle persists as a disabled disclosure (aria-expanded=true) so
    // focus is not lost when the wallet options appear.
    const toggleAfter = screen.getByRole("button", {
      name: /Continue with a wallet/i,
    });
    expect(toggleAfter.getAttribute("aria-expanded")).toBe("true");
    expect(toggleAfter.hasAttribute("disabled")).toBe(true);
  });
});
