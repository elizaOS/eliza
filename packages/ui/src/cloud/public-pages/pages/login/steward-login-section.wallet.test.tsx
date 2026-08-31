/** Verifies StewardLoginSection — wallet sign-in gating (SIWE/SIWS port) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Wallet (SIWE / SIWS) sign-in port — gating tests.
 *
 * The wallet branch renders ONLY when the live `auth.getProviders()` flags
 * serve `siwe`/`siws` (the bounded port from `cloud-frontend@4056e0e868`).
 * These tests pin the gate in both directions:
 *  - flags on  → the accessible Wallet icon opens a focused network chooser;
 *    the per-chain intent buttons appear in that dialog (Ethereum for `siwe`,
 *    Solana for `siws`) WITHOUT loading the wallet libs (they lazy-mount only
 *    after a network is selected).
 *  - flags off → no wallet UI at all (no tile or buttons).
 */

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

const providerFlags = vi.hoisted(() => ({ siwe: false, siws: false }));

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => false,
  consumeStewardCodeFromQuery: () => null,
  stripLegacyTokenHashFromAddressBar: () => false,
  exchangeStewardCodeViaApi: () => Promise.resolve({}),
  recoverStewardSessionViaCookie: () => Promise.resolve(null),
  refreshStewardSessionViaCookie: () => Promise.resolve({ ok: true as const }),
  syncStewardSessionCookie: () => Promise.resolve(),
}));

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class {
    getSession() {
      return null;
    }
    getProviders() {
      return Promise.resolve({
        passkey: true,
        email: true,
        siwe: providerFlags.siwe,
        siws: providerFlags.siws,
        google: true,
        discord: true,
        github: true,
        twitter: true,
        telegram: true,
        oauth: ["google"],
      });
    }
    refreshSession() {
      return Promise.resolve(null);
    }
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

vi.mock("../../lib/steward-oauth-url", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/steward-oauth-url")
  >("../../lib/steward-oauth-url");
  return {
    ...actual,
    consumeStewardPkceVerifier: () => undefined,
    buildStewardOAuthRedirectUri: () => "https://app.example.test/login",
    createStewardPkcePair: () =>
      Promise.resolve({ verifier: "verifier", challenge: "challenge" }),
    storeStewardPkceVerifier: () => true,
    buildStewardOAuthAuthorizeUrl: () => "https://auth.example.test/authorize",
  };
});

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/cloud",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

// The section normalizes and module-caches provider discovery. Import a fresh
// module for every case so each flag combination reaches the component rather
// than inheriting the first test's normalized snapshot.
async function renderSection() {
  vi.resetModules();
  const { default: StewardLoginSection } = await import(
    "./steward-login-section"
  );
  const rendered = render(
    <MemoryRouter initialEntries={["/login"]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return rendered;
}

async function walletProviderTile(): Promise<HTMLButtonElement> {
  const providerGroup = await screen.findByRole("group", {
    name: "or continue with",
  });
  const providerButtons = within(providerGroup).getAllByRole("button");
  const wallet = within(providerGroup).getByRole<HTMLButtonElement>("button", {
    name: "Continue with a wallet",
  });

  expect(providerButtons).toHaveLength(6);
  expect(providerButtons[5]).toBe(wallet);
  expect(wallet.getAttribute("aria-label")).toBe("Continue with a wallet");
  expect(wallet.getAttribute("title")).toBe("Continue with a wallet");
  expect(wallet.textContent?.trim()).toBe("");
  expect(wallet.querySelector("svg")).not.toBeNull();
  return wallet;
}

describe("StewardLoginSection — wallet sign-in gating (SIWE/SIWS port)", () => {
  beforeEach(() => {
    providerFlags.siwe = false;
    providerFlags.siws = false;
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens both network choices in a focused wallet dialog", async () => {
    providerFlags.siwe = true;
    providerFlags.siws = true;

    await renderSection();

    // The tile renders closed — no wallet dialog or network buttons yet.
    const walletToggle = await walletProviderTile();
    expect(walletToggle.getAttribute("aria-expanded")).toBe("false");
    expect(walletToggle.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ethereum" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Solana" })).toBeNull();

    // Opening the modal preserves the compact card and presents both choices.
    fireEvent.click(walletToggle);
    const dialog = await screen.findByRole("dialog", {
      name: "Continue with a wallet",
    });
    const controlledDialogId = walletToggle.getAttribute("aria-controls");
    expect(controlledDialogId).toBeTruthy();
    expect(document.getElementById(controlledDialogId ?? "")).toBe(dialog);
    expect(
      within(dialog).getByText("Choose a network to connect."),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Ethereum" }),
    ).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Solana" })).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Connecting is free. You’ll only be asked to sign a message.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("or sign in with a wallet")).toBeNull();
  }, 20_000);

  it("renders only the served network in the wallet dialog", async () => {
    providerFlags.siwe = true;

    await renderSection();

    // Open the wallet dialog first.
    const walletToggle = await walletProviderTile();
    fireEvent.click(walletToggle);

    const dialog = await screen.findByRole("dialog", {
      name: "Continue with a wallet",
    });
    expect(
      within(dialog).getByRole("button", { name: "Ethereum" }),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Solana" })).toBeNull();
  }, 20_000);

  it("renders NO wallet UI when neither siwe nor siws is served", async () => {
    await renderSection();

    // Wait for the providers fetch to settle (Google renders from the mock).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Google/i })).toBeTruthy(),
    );
    expect(
      screen.queryByRole("button", { name: "Continue with a wallet" }),
    ).toBeNull();
    expect(screen.queryByText("or sign in with a wallet")).toBeNull();
    expect(screen.queryByRole("button", { name: /EVM wallet/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Solana wallet/i })).toBeNull();
  });
});
