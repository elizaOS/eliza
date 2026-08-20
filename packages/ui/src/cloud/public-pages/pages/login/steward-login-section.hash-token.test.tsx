/**
 * Verifies StewardLoginSection never plants a session from a legacy `#token=`
 * hash link, with deterministic SDK and session-boundary doubles; no real
 * sessions are used.
 */
// @vitest-environment jsdom

/**
 * W5-013 regression: a clicked `/login#token=<jwt>&refreshToken=<jwt>` link
 * previously planted a full Steward session into the victim's browser
 * (login-CSRF — every subsequent action lands in the attacker's account), the
 * same impact class as the removed `?token=` query path. The hash path is now
 * stripped unconsumed: these tests pin that the section calls the strip
 * helper, never syncs the cookie or persists a token from the hash, and
 * settles on the ordinary sign-in options.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hashLinkState = vi.hoisted(() => ({
  stripHash: vi.fn(),
}));

const sessionSpies = vi.hoisted(() => ({
  storedToken: null as string | null,
  write: vi.fn(),
  sync: vi.fn(),
}));

vi.mock("@elizaos/shared/steward-session-client", () => ({
  hasStewardAuthedCookie: () => false,
  readStoredStewardToken: () => sessionSpies.storedToken,
  writeStoredStewardToken: (token: string) => {
    sessionSpies.storedToken = token;
    sessionSpies.write(token);
  },
  StewardSessionError: class StewardSessionError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class {
    getSession() {
      return null;
    }
    getProviders() {
      return Promise.resolve({
        passkey: false,
        email: true,
        siwe: false,
        siws: false,
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

vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: () =>
    Promise.resolve({ usable: false, reason: "native-without-bridge" }),
}));

vi.mock("../../../shell/steward-url", () => ({
  resolveBrowserStewardApiUrl: () => "https://api.example.test/steward",
}));

vi.mock("../../../shell/steward-config", () => ({
  configuredStewardTenantId: () => "elizacloud",
  DEFAULT_STEWARD_TENANT_ID: "elizacloud",
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("../../lib/steward-session", () => ({
  // The real peek returns true for a `#token=` hash; the strip is doubled with
  // a spy (its own unit tests live in lib/steward-session.hash-strip.test.ts).
  hasStewardOAuthCallbackInUrl: () => true,
  consumeStewardCodeFromQuery: () => null,
  stripLegacyTokenHashFromAddressBar: hashLinkState.stripHash,
  exchangeStewardCodeViaApi: vi.fn(),
  recoverStewardSessionViaCookie: vi.fn(),
  refreshStewardSessionViaCookie: vi.fn(),
  syncStewardSessionCookie: sessionSpies.sync,
}));

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/cloud",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

import StewardLoginSection from "./steward-login-section";

describe("StewardLoginSection — legacy #token= hash link (W5-013)", () => {
  beforeEach(() => {
    hashLinkState.stripHash.mockReturnValue(true);
    sessionSpies.storedToken = null;
    sessionSpies.sync.mockResolvedValue(undefined);
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("strips the credential hash and never plants a session from it", async () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <StewardLoginSection />
      </MemoryRouter>,
    );

    // The completing-sign-in gate clears and the ordinary options render.
    await screen.findByRole("button", { name: "Magic Link" });

    expect(hashLinkState.stripHash).toHaveBeenCalled();
    expect(sessionSpies.sync).not.toHaveBeenCalled();
    expect(sessionSpies.write).not.toHaveBeenCalled();
    expect(sessionSpies.storedToken).toBeNull();
  });

  it("shows the sign-in options (not a stuck completing state) after the strip", async () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <StewardLoginSection />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Google" })).toBeTruthy(),
    );
    expect(screen.queryByText(/Completing sign-in/)).toBeNull();
  });
});
