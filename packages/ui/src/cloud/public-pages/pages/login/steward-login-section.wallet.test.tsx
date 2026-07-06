// @vitest-environment jsdom

/**
 * Wallet (SIWE / SIWS) sign-in port — gating tests.
 *
 * The wallet branch renders ONLY when the live `auth.getProviders()` flags
 * serve `siwe`/`siws` (the bounded port from `cloud-frontend@4056e0e868`).
 * These tests pin the gate in both directions:
 *  - flags on  → the "or sign in with a wallet" divider + per-chain intent
 *    buttons render (EVM for `siwe`, Solana for `siws`), WITHOUT loading the
 *    wallet libs (they lazy-mount on click).
 *  - flags off → no wallet UI at all (the pre-port behavior).
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerFlags = vi.hoisted(() => ({ siwe: false, siws: false }));

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => false,
  consumeStewardCodeFromQuery: () => null,
  consumeStewardTokensFromHash: () => null,
  exchangeStewardCodeViaApi: () => Promise.resolve({}),
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
        discord: false,
        github: false,
        twitter: false,
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
  };
});

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/dashboard",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

// The section module-caches the providers fetch (`cachedStewardProviders`),
// so each test must import a FRESH module instance or the first test's flags
// leak into the rest.
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

describe("StewardLoginSection — wallet sign-in gating (SIWE/SIWS port)", () => {
  beforeEach(() => {
    providerFlags.siwe = false;
    providerFlags.siws = false;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the wallet divider + both chain intent buttons when siwe AND siws are served", async () => {
    providerFlags.siwe = true;
    providerFlags.siws = true;

    await renderSection();

    await waitFor(() =>
      expect(screen.getByText("or sign in with a wallet")).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /EVM wallet/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Solana wallet/i })).toBeTruthy();
  });

  it("renders only the served chain's button (siwe only → EVM, no Solana)", async () => {
    providerFlags.siwe = true;

    await renderSection();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /EVM wallet/i })).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /Solana wallet/i })).toBeNull();
  });

  it("renders NO wallet UI when neither siwe nor siws is served", async () => {
    await renderSection();

    // Wait for the providers fetch to settle (Google renders from the mock).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Google/i })).toBeTruthy(),
    );
    expect(screen.queryByText("or sign in with a wallet")).toBeNull();
    expect(screen.queryByRole("button", { name: /EVM wallet/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Solana wallet/i })).toBeNull();
  });
});
