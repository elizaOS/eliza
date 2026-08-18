/** Verifies StewardLoginSection — OAuth callback completion state (#13519) through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * #13519: after a successful OAuth callback the login section must NOT re-render
 * the provider options while the token exchange is in flight — that re-render is
 * what read as the login "flashing back to the sign-in options" after success.
 *
 * This test renders the section with an OAuth callback present in the URL and a
 * never-resolving exchange, and asserts it holds a terminal "Completing
 * sign-in…" state (no email input, no passkey/OAuth buttons). A companion case
 * asserts a callback FAILURE clears that state and surfaces the error + the
 * options again, so a real failure is never hidden behind the spinner.
 */

import { StewardSessionError } from "@elizaos/shared/steward-session-client";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callbackState = vi.hoisted(() => ({
  hasCallback: true,
  expectedState: "state-1" as string | null,
  pkceVerifier: "verifier-1" as string | undefined,
  exchangeCalls: 0,
  exchange: (): Promise<{ token?: string }> => new Promise(() => {}),
}));

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => callbackState.hasCallback,
  consumeStewardCodeFromQuery: () => "callback-code",
  stripLegacyTokenHashFromAddressBar: () => false,
  exchangeStewardCodeViaApi: () => {
    callbackState.exchangeCalls += 1;
    return callbackState.exchange();
  },
  recoverStewardSessionViaCookie: () => Promise.resolve(null),
  refreshStewardSessionViaCookie: () => Promise.resolve({ ok: true as const }),
  syncStewardSessionCookie: () => Promise.resolve(),
}));

vi.mock("@elizaos/shared/steward-session-client", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/shared/steward-session-client")
  >("@elizaos/shared/steward-session-client");
  return {
    ...actual,
    peekStewardOAuthState: () => callbackState.expectedState,
  };
});

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class {
    getSession() {
      return null;
    }
    getProviders() {
      return Promise.resolve({
        passkey: true,
        email: true,
        siwe: false,
        siws: false,
        google: true,
        discord: true,
        github: false,
        twitter: false,
        oauth: ["google", "discord"],
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
    consumeStewardPkceVerifier: () => callbackState.pkceVerifier,
    buildStewardOAuthRedirectUri: () => "https://app.example.test/login",
  };
});

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/cloud",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

import StewardLoginSection from "./steward-login-section";

function renderSection(initialUrl = "/login?code=callback-code&state=state-1") {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

describe("StewardLoginSection — OAuth callback completion state (#13519)", () => {
  beforeEach(() => {
    callbackState.hasCallback = true;
    callbackState.expectedState = "state-1";
    callbackState.pkceVerifier = "verifier-1";
    callbackState.exchangeCalls = 0;
    callbackState.exchange = () => new Promise(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows a terminal 'Completing sign-in…' state and NOT the provider options while a callback exchange is in flight", async () => {
    renderSection();

    await waitFor(() =>
      expect(screen.getByText("Completing sign-in…")).toBeTruthy(),
    );

    // The provider options must not be rendered underneath — no flash back.
    expect(screen.queryByPlaceholderText("you@example.com")).toBeNull();
    expect(screen.queryByRole("button", { name: /Passkey/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Magic Link/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Google/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Discord/i })).toBeNull();
  });

  it("clears the completing state and surfaces the error when the callback exchange fails", async () => {
    callbackState.exchange = () =>
      Promise.reject(new Error("Could not complete Eliza Cloud sign-in."));

    renderSection();

    await waitFor(() =>
      expect(
        screen.getByText("Could not complete Eliza Cloud sign-in."),
      ).toBeTruthy(),
    );

    // Completing spinner is gone; the sign-in options are reachable again.
    expect(screen.queryByText("Completing sign-in…")).toBeNull();
    expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy();
  });

  it("shows a friendly 'expired / try again' message (not the raw 401) when a stale or cross-tenant one-time code is rejected", async () => {
    // A prod-issued code replayed against staging comes back 401 — benign and
    // recoverable, so the copy must invite a fresh sign-in, not read as broken.
    callbackState.exchange = () =>
      Promise.reject(
        new StewardSessionError("Unauthorized", 401, "code_tenant_mismatch"),
      );

    renderSection();

    await waitFor(() =>
      expect(
        screen.getByText(
          "That sign-in link expired or was already used. Please sign in again below.",
        ),
      ).toBeTruthy(),
    );
    // The raw upstream error is not surfaced, and the form is usable again.
    expect(screen.queryByText(/Unauthorized/)).toBeNull();
    expect(screen.queryByText("Completing sign-in…")).toBeNull();
    expect(screen.getByPlaceholderText("you@example.com")).toBeTruthy();
  });

  it("refuses the exchange when the callback state does not match the stashed state", async () => {
    callbackState.expectedState = "different-state";

    renderSection("/login?code=callback-code&state=state-1");

    await waitFor(() =>
      expect(
        screen.getByText(
          "This sign-in link is invalid or has expired. Please start sign-in again.",
        ),
      ).toBeTruthy(),
    );
    expect(callbackState.exchangeCalls).toBe(0);
    expect(screen.queryByText("Completing sign-in…")).toBeNull();
  });

  it("refuses the exchange when the callback carries no state echo", async () => {
    renderSection("/login?code=callback-code");

    await waitFor(() =>
      expect(
        screen.getByText(
          "This sign-in link is invalid or has expired. Please start sign-in again.",
        ),
      ).toBeTruthy(),
    );
    expect(callbackState.exchangeCalls).toBe(0);
  });

  it("refuses the exchange when the stored PKCE verifier is gone", async () => {
    callbackState.pkceVerifier = undefined;

    renderSection("/login?code=callback-code&state=state-1");

    await waitFor(() =>
      expect(
        screen.getByText(
          "This sign-in was started in another tab or has expired. Please start sign-in again.",
        ),
      ).toBeTruthy(),
    );
    expect(callbackState.exchangeCalls).toBe(0);
  });
});
