/**
 * Verifies StewardLoginSection's session-cached provider fast path (#18256)
 * under a mocked Steward harness (jsdom). A per-tenant sessionStorage snapshot
 * of the last provider discovery must render cached non-wallet options
 * immediately on a repeat SPA load (no "Loading sign-in options…" roundtrip on
 * the critical path), reconcile with the live fetch when it resolves, and the
 * completing-callback return leg must not issue a discovery fetch at all.
 * Wallet providers remain behind current-document live discovery because
 * mounting one can auto-reconnect persisted browser state. A corrupt snapshot
 * must fall back to the discovery skeleton, never to a fake-valid provider set.
 *
 * The section module deduplicates one in-flight discovery promise and retains
 * the last resolved set for initial paint. These tests share a single
 * controlled deferred sequence and run in a deliberate order: every test
 * before the final one leaves discovery unresolved (assertions are synchronous
 * or fetch-free), and the final test settles success, remount failure, and
 * retry success in order.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const providerDeferreds: Promise<unknown>[] = [];
  const resolveProviders: Array<(value: unknown) => void> = [];
  const rejectProviders: Array<(reason: unknown) => void> = [];
  for (let index = 0; index < 3; index += 1) {
    providerDeferreds.push(
      new Promise<unknown>((resolve, reject) => {
        resolveProviders.push(resolve);
        rejectProviders.push(reject);
      }),
    );
  }
  return {
    hasCallback: false,
    code: null as string | null,
    getProvidersCalls: 0,
    providerDeferreds,
    rejectProviders,
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
      const deferred = harness.providerDeferreds[harness.getProvidersCalls];
      harness.getProvidersCalls += 1;
      return (
        deferred ??
        Promise.reject(new Error("Unexpected extra provider discovery call"))
      );
    }
    refreshSession() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: () => new Promise(() => {}),
}));

vi.mock("./telegram-login-widget", () => ({
  configuredTelegramBotUsername: () => "elizastagingfelibot",
  TelegramLoginWidget: () => null,
  TelegramLoginCancelledError: class TelegramLoginCancelledError extends Error {},
  getConfiguredTelegramBotId: () => "7684336618",
  requestTelegramLogin: () => new Promise(() => {}),
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

const WALLET_ONLY_PROVIDERS = {
  ...CACHED_PROVIDERS,
  passkey: false,
  email: false,
  sms: false,
  siwe: true,
  siws: true,
  google: false,
  discord: false,
  github: false,
  telegram: false,
};

function resolveProviderCall(index: number, value: unknown): void {
  const resolve = harness.resolveProviders[index];
  if (!resolve) throw new Error(`Missing provider resolver ${index}`);
  resolve(value);
}

function rejectProviderCall(index: number, reason: unknown): void {
  const reject = harness.rejectProviders[index];
  if (!reject) throw new Error(`Missing provider rejecter ${index}`);
  reject(reason);
}

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

  it("does not activate cached wallet providers before live discovery", () => {
    window.sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        ...CACHED_PROVIDERS,
        siwe: true,
        siws: true,
      }),
    );

    renderSection("/login");

    expect(screen.getByRole("button", { name: /^Google$/i })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Continue with a wallet/i }),
    ).toBeNull();
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

  it("requires remount revalidation and recovers a wallet-only cache after failure", async () => {
    window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(CACHED_PROVIDERS));

    const firstMount = renderSection("/login");
    expect(screen.queryByRole("button", { name: /^GitHub$/i })).toBeNull();

    resolveProviderCall(0, WALLET_ONLY_PROVIDERS);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Continue with a wallet/i }),
      ).toBeTruthy(),
    );
    // The successful discovery refreshes the snapshot for the next load.
    const stored = window.sessionStorage.getItem(CACHE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string).siws).toBe(true);

    firstMount.unmount();
    const callsBeforeRemount = harness.getProvidersCalls;
    renderSection("/login");

    await waitFor(() =>
      expect(harness.getProvidersCalls).toBe(callsBeforeRemount + 1),
    );
    // The module cache cannot activate its cached wallet positives before the
    // remount's live discovery resolves.
    expect(
      screen.queryByRole("button", { name: /Continue with a wallet/i }),
    ).toBeNull();

    rejectProviderCall(
      1,
      new Error("Provider service is temporarily unavailable"),
    );
    expect(
      await screen.findByText("Sign-in options couldn't load"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Retry sign-in options" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Continue with a wallet/i }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry sign-in options" }),
    );
    await waitFor(() => expect(harness.getProvidersCalls).toBe(3));
    resolveProviderCall(2, { ...WALLET_ONLY_PROVIDERS, siws: false });

    const walletToggle = await screen.findByRole("button", {
      name: /Continue with a wallet/i,
    });
    fireEvent.click(walletToggle);
    expect(
      await screen.findByRole("button", { name: /EVM wallet/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Solana wallet/i })).toBeNull();
  });
});
