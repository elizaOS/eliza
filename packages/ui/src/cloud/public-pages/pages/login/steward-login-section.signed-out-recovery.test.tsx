/**
 * Verifies that an explicit sign-out stays signed out on the login page: a
 * refresh cookie that survived the sign-out is not used to silently restore
 * the ended account (the `/join` sign-out loop in #29918), while an ordinary
 * returning visitor without that marker is still restored. SDK and session
 * boundaries are deterministic doubles; no real sessions are used.
 */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionSpies = vi.hoisted(() => ({
  storedToken: null as string | null,
  write: vi.fn(),
  recover: vi.fn(),
}));

vi.mock(
  "@elizaos/plugin-elizacloud/steward-session-client",
  async (importOriginal) => ({
    ...(await importOriginal()),
    hasStewardAuthedCookie: () => true,
    readStoredStewardToken: () => sessionSpies.storedToken,
    writeStoredStewardToken: (token: string) => {
      sessionSpies.storedToken = token;
      sessionSpies.write(token);
    },
  }),
);

vi.mock("@elizaos/auth", () => ({
  LoginAuth: class {
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
  hasStewardOAuthCallbackInUrl: () => false,
  consumeStewardCodeFromQuery: () => null,
  stripLegacyTokenHashFromAddressBar: () => false,
  exchangeStewardCodeViaApi: vi.fn(),
  recoverStewardSessionViaCookie: sessionSpies.recover,
  refreshStewardSessionViaCookie: vi.fn(),
  syncStewardSessionCookie: vi.fn(),
}));

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/join",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn() },
}));

import StewardLoginSection from "./steward-login-section";

const LOGGED_OUT_KEY = "eliza_sso_logged_out";

describe("StewardLoginSection — explicit sign-out stays signed out", () => {
  beforeEach(() => {
    sessionSpies.storedToken = null;
    sessionSpies.recover.mockResolvedValue({ ok: true, token: "revived-jwt" });
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("does not restore a surviving cookie session after an explicit sign-out", async () => {
    window.localStorage.setItem(LOGGED_OUT_KEY, "1");
    render(
      <MemoryRouter initialEntries={["/login?returnTo=/join"]}>
        <StewardLoginSection />
      </MemoryRouter>,
    );

    await screen.findByRole("button", { name: "Magic Link" });
    expect(sessionSpies.recover).not.toHaveBeenCalled();
    expect(sessionSpies.write).not.toHaveBeenCalled();
    expect(sessionSpies.storedToken).toBeNull();
  });

  it("still restores a returning cookie session without an explicit sign-out", async () => {
    render(
      <MemoryRouter initialEntries={["/login?returnTo=/join"]}>
        <StewardLoginSection />
      </MemoryRouter>,
    );

    await waitFor(() => expect(sessionSpies.recover).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(sessionSpies.write).toHaveBeenCalledWith("revived-jwt"),
    );
  });
});
