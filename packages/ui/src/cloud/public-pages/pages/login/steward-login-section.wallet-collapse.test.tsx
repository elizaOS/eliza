/** Verifies StewardLoginSection wallet-method collapse (#19217). */
// @vitest-environment jsdom

import {
  act,
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

const mountedWalletCapabilities = vi.hoisted(() => ({
  siwe: null as boolean | null,
  siws: null as boolean | null,
}));

const mountedProviderCapabilities = vi.hoisted(() => ({
  enableEvm: null as boolean | null,
  enableSolana: null as boolean | null,
}));

const PROVIDERS_CACHE_KEY = "eliza.steward.providers.v1:elizacloud";

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
  StewardWalletProviders: ({
    children,
    enableEvm,
    enableSolana,
  }: {
    children: React.ReactNode;
    enableEvm: boolean;
    enableSolana: boolean;
  }) => {
    mountedProviderCapabilities.enableEvm = enableEvm;
    mountedProviderCapabilities.enableSolana = enableSolana;
    return <>{children}</>;
  },
}));

vi.mock("./wallet-buttons", () => ({
  WalletButtons: ({ siwe, siws }: { siwe: boolean; siws: boolean }) => {
    mountedWalletCapabilities.siwe = siwe;
    mountedWalletCapabilities.siws = siws;
    return <div data-testid="mounted-wallet-buttons">Mounted wallet stack</div>;
  },
}));

// The section caches provider discovery at module scope. Import a fresh module
// for each case so one test's served chains cannot leak into the next case.
async function renderSection() {
  vi.resetModules();
  const { default: StewardLoginSection } = await import(
    "./steward-login-section"
  );
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
    mountedWalletCapabilities.siwe = null;
    mountedWalletCapabilities.siws = null;
    mountedProviderCapabilities.enableEvm = null;
    mountedProviderCapabilities.enableSolana = null;
    window.sessionStorage.removeItem(PROVIDERS_CACHE_KEY);
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.removeItem(PROVIDERS_CACHE_KEY);
    vi.clearAllMocks();
  });

  it("collapses wallet methods behind a two-way disclosure toggle", async () => {
    await renderSection();

    // Wait for provider discovery to settle, then the collapsed toggle appears.
    const walletToggle = await screen.findByRole("button", {
      name: /Continue with a wallet/i,
    });
    expect(screen.queryByRole("button", { name: "Apple" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Telegram" })).toBeNull();

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
      name: /Collapse wallet options/i,
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
    await renderSection();

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
      name: /Wallet options/i,
    });
    expect(lockedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(lockedToggle.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: /EVM wallet/i })).toBeNull();
    expect(await screen.findByTestId("mounted-wallet-buttons")).toBeTruthy();
    expect(mountedWalletCapabilities).toEqual({ siwe: true, siws: true });
    expect(mountedProviderCapabilities).toEqual({
      enableEvm: true,
      enableSolana: true,
    });

    const liveRegion = document.getElementById("steward-wallet-options");
    expect(liveRegion).toBeTruthy();
    expect(liveRegion?.hasAttribute("hidden")).toBe(false);
    // Focus must land in the controlled region (not body / not the disabled
    // toggle) after the peer button unmounts and the disclosure locks.
    expect(document.activeElement).toBe(liveRegion);
  });

  it("revokes mounted wallets on BFCache restore until fresh discovery succeeds", async () => {
    let resolveStaleProviders!: (
      providers: ReturnType<typeof walletProviders>,
    ) => void;
    const staleProviders = new Promise<ReturnType<typeof walletProviders>>(
      (resolve) => {
        resolveStaleProviders = resolve;
      },
    );
    let resolveFreshProviders!: (
      providers: ReturnType<typeof walletProviders>,
    ) => void;
    const freshProviders = new Promise<ReturnType<typeof walletProviders>>(
      (resolve) => {
        resolveFreshProviders = resolve;
      },
    );
    stewardAuthSpies.getProviders
      .mockResolvedValueOnce(walletProviders())
      .mockReturnValueOnce(staleProviders)
      .mockReturnValueOnce(freshProviders)
      .mockRejectedValueOnce(new Error("provider discovery unavailable"));

    await renderSection();
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Continue with a wallet/i,
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /EVM wallet/i }));
    expect(await screen.findByTestId("mounted-wallet-buttons")).toBeTruthy();

    const historyRestore = new Event("pageshow");
    Object.defineProperty(historyRestore, "persisted", { value: true });
    fireEvent(window, historyRestore);

    expect(screen.queryByTestId("mounted-wallet-buttons")).toBeNull();
    await waitFor(() =>
      expect(stewardAuthSpies.getProviders).toHaveBeenCalledTimes(2),
    );
    expect(screen.queryByTestId("mounted-wallet-buttons")).toBeNull();

    // A second persisted restoration supersedes the still-pending request.
    // Resolving that stale promise must not restore the retained wallet intent.
    const secondRestore = new Event("pageshow");
    Object.defineProperty(secondRestore, "persisted", { value: true });
    fireEvent(window, secondRestore);
    await waitFor(() =>
      expect(stewardAuthSpies.getProviders).toHaveBeenCalledTimes(3),
    );
    await act(async () => {
      resolveStaleProviders(walletProviders());
      await staleProviders;
    });
    expect(screen.queryByTestId("mounted-wallet-buttons")).toBeNull();

    await act(async () => {
      resolveFreshProviders(walletProviders());
      await freshProviders;
    });
    expect(await screen.findByTestId("mounted-wallet-buttons")).toBeTruthy();

    const failedRestore = new Event("pageshow");
    Object.defineProperty(failedRestore, "persisted", { value: true });
    fireEvent(window, failedRestore);

    expect(screen.queryByTestId("mounted-wallet-buttons")).toBeNull();
    await waitFor(() =>
      expect(stewardAuthSpies.getProviders).toHaveBeenCalledTimes(4),
    );
    await screen.findByRole("alert");
    expect(screen.queryByTestId("mounted-wallet-buttons")).toBeNull();
  });

  it.each([
    {
      label: "SIWE-only",
      siwe: true,
      siws: false,
      intentName: /EVM wallet/i,
    },
    {
      label: "SIWS-only",
      siwe: false,
      siws: true,
      intentName: /Solana wallet/i,
    },
  ])(
    "keeps provider initialization inside $label discovery",
    async ({ siwe, siws, intentName }) => {
      stewardAuthSpies.getProviders.mockResolvedValue({
        ...walletProviders(),
        siwe,
        siws,
      });
      await renderSection();

      fireEvent.click(
        await screen.findByRole("button", {
          name: /Continue with a wallet/i,
        }),
      );
      fireEvent.click(await screen.findByRole("button", { name: intentName }));

      expect(await screen.findByTestId("mounted-wallet-buttons")).toBeTruthy();
      expect(mountedWalletCapabilities).toEqual({ siwe, siws });
      expect(mountedProviderCapabilities).toEqual({
        enableEvm: siwe,
        enableSolana: siws,
      });
    },
  );
});
