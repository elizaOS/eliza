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
  stripLegacyTokenHashFromAddressBar: () => false,
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

// Lazy wallet stack is heavy; for disclosure/intent tests stub both pieces so
// clicking a chain button can exercise the post-intent lock without RainbowKit.
vi.mock("../../../billing/wallet/steward-wallet-providers", () => ({
  StewardWalletProviders: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("./wallet-buttons", () => ({
  WalletButtons: () => (
    <div data-testid="mounted-wallet-buttons">Mounted wallet stack</div>
  ),
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

  it("collapses wallet methods behind a two-way disclosure toggle", async () => {
    renderSection();

    // Wait for provider discovery to settle, then the collapsed toggle appears.
    const walletToggle = await screen.findByRole("button", {
      name: /Continue with a wallet/i,
    });

    // Disclosure semantics: collapsed state has aria-expanded=false and the
    // button is NOT disabled — keyboard users can focus and activate it.
    expect(walletToggle.getAttribute("aria-expanded")).toBe("false");
    expect(walletToggle.getAttribute("aria-controls")).toBe(
      "steward-wallet-options",
    );
    expect(walletToggle.hasAttribute("disabled")).toBe(false);

    // The controlled region is always in the DOM (aria-controls resolves) but
    // hidden when collapsed, so screen readers don't announce stale contents.
    const region = document.getElementById("steward-wallet-options");
    expect(region).toBeTruthy();
    expect(region?.hasAttribute("hidden")).toBe(true);

    // Wallet peer buttons must NOT be visible until the user expands.
    expect(screen.queryByText("EVM wallet")).toBeNull();
    expect(screen.queryByText("Solana wallet")).toBeNull();

    // Expanding reveals the individual wallet buttons.
    fireEvent.click(walletToggle);
    expect(await screen.findByText("EVM wallet")).toBeTruthy();
    expect(screen.getByText("Solana wallet")).toBeTruthy();

    // The toggle is an enabled disclosure with aria-expanded=true — focus is
    // never lost because the control does not get disabled on expansion.
    const toggleExpanded = screen.getByRole("button", {
      name: /Continue with a wallet/i,
    });
    expect(toggleExpanded.getAttribute("aria-expanded")).toBe("true");
    expect(toggleExpanded.hasAttribute("disabled")).toBe(false);
    expect(region?.hasAttribute("hidden")).toBe(false);

    // Collapsing again hides the wallet buttons (two-way disclosure).
    fireEvent.click(toggleExpanded);
    expect(toggleExpanded.getAttribute("aria-expanded")).toBe("false");
    expect(region?.hasAttribute("hidden")).toBe(true);
    expect(screen.queryByText("EVM wallet")).toBeNull();
    expect(screen.queryByText("Solana wallet")).toBeNull();
  });

  it("locks the disclosure only after wallet intent and moves focus into the live region", async () => {
    renderSection();

    const walletToggle = await screen.findByRole("button", {
      name: /Continue with a wallet/i,
    });
    fireEvent.click(walletToggle);

    const evmButton = await screen.findByRole("button", {
      name: /EVM wallet/i,
    });
    // Simulate keyboard activation of a peer intent button so focus would
    // otherwise be stranded when that button unmounts.
    evmButton.focus();
    expect(document.activeElement).toBe(evmButton);
    fireEvent.click(evmButton);

    // Distinct post-intent state: toggle stays expanded but is now disabled
    // because collapse is no longer meaningful once the lazy stack is mounted.
    const lockedToggle = screen.getByRole("button", {
      name: /Continue with a wallet/i,
    });
    expect(lockedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(lockedToggle.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: /EVM wallet/i })).toBeNull();
    expect(await screen.findByTestId("mounted-wallet-buttons")).toBeTruthy();

    const liveRegion = document.getElementById("steward-wallet-options");
    expect(liveRegion).toBeTruthy();
    expect(liveRegion?.hasAttribute("hidden")).toBe(false);
    // Focus must land in the controlled region (not body / not the disabled
    // toggle) after the peer button unmounts and the disclosure locks.
    expect(document.activeElement).toBe(liveRegion);
  });
});
