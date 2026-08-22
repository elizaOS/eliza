/**
 * Verifies StewardLoginSection's session-cached provider fast path (#18256)
 * under a mocked Steward harness (jsdom). A per-tenant sessionStorage snapshot
 * of the last provider discovery must render the real option stack immediately
 * on a repeat SPA load (no "Loading sign-in options…" roundtrip on the
 * critical path), reconcile with the live fetch when it resolves, and the
 * completing-callback return leg must not issue a discovery fetch at all. A
 * corrupt snapshot must fall back to the discovery skeleton, never to a
 * fake-valid provider set.
 *
 * The section module memoizes discovery process-wide (one in-flight promise,
 * one resolved set), so these tests share a single controlled deferred and run
 * in a deliberate order: every test before the final one leaves discovery
 * unresolved (assertions are synchronous or fetch-free), and only the last
 * test resolves it.
 */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  let resolveProviders: (value: unknown) => void = () => {};
  const providersDeferred = new Promise<unknown>((resolve) => {
    resolveProviders = resolve;
  });
  return {
    hasCallback: false,
    code: null as string | null,
    getProvidersCalls: 0,
    providersDeferred,
    resolveProviders,
  };
});

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => harness.hasCallback,
  consumeStewardCodeFromQuery: () => harness.code,
  consumeStewardOAuthStateFromCallback: () => "state-1",
  stripLegacyTokenHashFromAddressBar: () => false,
  exchangeStewardCodeViaApi: () => new Promise(() => {}),
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
      harness.getProvidersCalls += 1;
      return harness.providersDeferred;
    }
    refreshSession() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: () => new Promise(() => {}),
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

vi.mock("@elizaos/shared/steward-session-client", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/shared/steward-session-client")
  >("@elizaos/shared/steward-session-client");
  return {
    ...actual,
    peekStewardOAuthState: () => "state-1",
  };
});

vi.mock("../../lib/steward-oauth-url", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/steward-oauth-url")
  >("../../lib/steward-oauth-url");
  return {
    ...actual,
    consumeStewardPkceVerifier: () => "verifier-1",
    buildStewardOAuthRedirectUri: () => "https://app.example.test/login",
  };
});

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/cloud",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

import StewardLoginSection from "./steward-login-section";

const CACHE_KEY = "eliza.steward.providers.v1:elizacloud";

const CACHED_PROVIDERS = {
  passkey: false,
  email: true,
  sms: false,
  siwe: false,
  siws: false,
  google: true,
  discord: true,
  github: false,
  telegram: true,
  twitter: false,
  oauth: [],
};

function renderSection(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

describe("StewardLoginSection — session-cached provider fast path (#18256)", () => {
  beforeEach(() => {
    harness.hasCallback = false;
    harness.code = null;
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("falls back to the discovery skeleton on a corrupt snapshot", () => {
    window.sessionStorage.setItem(CACHE_KEY, "{not json");

    renderSection("/login");

    expect(
      screen.getByRole("status", { name: "Loading sign-in options" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("rejects a structurally incomplete or mistyped provider snapshot", () => {
    window.sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        ...CACHED_PROVIDERS,
        telegram: "true",
      }),
    );

    renderSection("/login");

    expect(
      screen.getByRole("status", { name: "Loading sign-in options" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders cached options immediately while live discovery is still pending", () => {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(CACHED_PROVIDERS));

    renderSection("/login");

    // No blocking discovery state — the cached stack is live from first render.
    expect(
      screen.queryByRole("status", { name: "Loading sign-in options" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /^Google$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Telegram$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^GitHub$/i })).toBeNull();
  });

  it("does not fetch provider discovery on the completing-callback return leg", async () => {
    harness.hasCallback = true;
    harness.code = "callback-code";
    const callsBefore = harness.getProvidersCalls;

    renderSection("/login?code=callback-code&state=state-1");

    await waitFor(() =>
      expect(screen.getByText("Completing sign-in…")).toBeTruthy(),
    );
    expect(harness.getProvidersCalls).toBe(callsBefore);
  });

  it("reconciles the cached stack with the fetched config when discovery resolves", async () => {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(CACHED_PROVIDERS));

    renderSection("/login");
    expect(screen.queryByRole("button", { name: /^GitHub$/i })).toBeNull();

    harness.resolveProviders({
      ...CACHED_PROVIDERS,
      github: true,
      telegram: false,
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^GitHub$/i })).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /^Telegram$/i })).toBeNull();
    // The successful discovery refreshes the snapshot for the next load.
    const stored = window.sessionStorage.getItem(CACHE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string).github).toBe(true);
  });
});
