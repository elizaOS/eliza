/** Verifies StewardLoginSection wallet-method modal (#19217). */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

const walletLauncherHarness = vi.hoisted(() => ({
  onLoadingChange: null as
    | ((kind: "ethereum" | "solana" | null) => void)
    | null,
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
  WalletAutoLauncher: ({
    onLoadingChange,
  }: {
    onLoadingChange: (kind: "ethereum" | "solana" | null) => void;
  }) => {
    walletLauncherHarness.onLoadingChange = onLoadingChange;
    return (
      <div data-testid="mounted-wallet-launcher">Mounted wallet stack</div>
    );
  },
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
    telegram: false,
    oauth: [],
  };
}

describe("StewardLoginSection wallet dialog (#19217)", () => {
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
    walletLauncherHarness.onLoadingChange = null;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens and closes wallet methods in a modal", async () => {
    renderSection();

    // Wait for provider discovery to settle, then the modal trigger appears.
    const walletToggle = await screen.findByRole("button", {
      name: /Continue with a wallet/i,
    });
    expect(screen.queryByRole("button", { name: "Apple" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Telegram" })).toBeNull();

    // Dialog semantics: closed state is focusable and advertises a dialog.
    expect(walletToggle.getAttribute("aria-expanded")).toBe("false");
    expect(walletToggle.getAttribute("aria-haspopup")).toBe("dialog");
    expect(walletToggle.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();

    // Wallet peer buttons must NOT be visible until the user expands.
    expect(screen.queryByText("Ethereum")).toBeNull();
    expect(screen.queryByText("Solana")).toBeNull();

    // Opening reveals the network choices without expanding the login card.
    fireEvent.click(walletToggle);
    const dialog = await screen.findByRole("dialog", {
      name: "Continue with a wallet",
    });
    expect(
      within(dialog).getByRole("button", { name: "Ethereum" }),
    ).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Solana" })).toBeTruthy();

    // The canonical close action restores focus to the trigger.
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const restoredTrigger = screen.getByRole("button", {
      name: /Continue with a wallet/i,
    });
    expect(restoredTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(restoredTrigger);
  });

  it("closes the chooser before starting the lazy wallet stack", async () => {
    renderSection();

    const walletToggle = await screen.findByRole("button", {
      name: /Continue with a wallet/i,
    });
    fireEvent.click(walletToggle);

    const dialog = await screen.findByRole("dialog", {
      name: "Continue with a wallet",
    });
    const ethereumButton = within(dialog).getByRole("button", {
      name: "Ethereum",
    });
    ethereumButton.focus();
    expect(document.activeElement).toBe(ethereumButton);
    fireEvent.click(ethereumButton);

    expect(await screen.findByTestId("mounted-wallet-launcher")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // The headless launcher stays mounted outside the chooser, avoiding a
    // nested focus trap when RainbowKit or Solana opens its own modal. Radix
    // restores focus to the still-focusable, busy trigger in the meantime.
    const loadingTrigger = screen.getByRole("button", {
      name: "Loading wallet options",
    });
    expect(loadingTrigger.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(loadingTrigger);

    // The real launcher reports wallet-owned loading as soon as an extension
    // or signing flow begins. Keep the return target natively focusable so a
    // cancelled vendor modal cannot strand keyboard focus.
    act(() => walletLauncherHarness.onLoadingChange?.("ethereum"));
    const signingTrigger = screen.getByRole("button", {
      name: "Loading wallet options",
    });
    expect(signingTrigger.hasAttribute("disabled")).toBe(false);
    expect(signingTrigger.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(signingTrigger);
  });
});
