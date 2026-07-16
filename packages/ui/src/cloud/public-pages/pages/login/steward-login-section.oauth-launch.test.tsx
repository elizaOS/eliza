// @vitest-environment jsdom

/**
 * Exercises hosted OAuth popup navigation and PKCE failure cleanup with an
 * in-memory Steward provider boundary; no live browser or OAuth service runs.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const oauthState = vi.hoisted(() => ({
  popup: null as Window | null,
  pkceError: null as Error | null,
  preOpenCalls: 0,
  storeVerifier: true,
}));

vi.mock("../../../../state/cloud-login-launch", () => ({
  canNavigateSameTabForBlockedPopup: () => true,
  preOpenCloudLoginWindow: () => {
    oauthState.preOpenCalls += 1;
    return oauthState.popup;
  },
  shouldReuseCurrentCloudLoginWindow: (returnTo: string | null) =>
    returnTo === "/auth/cli-login" ||
    returnTo?.startsWith("/auth/cli-login?") === true,
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
  consumeStewardTokensFromHash: () => null,
  exchangeStewardCodeViaApi: () => Promise.resolve({}),
  refreshStewardSessionViaCookie: () => Promise.resolve({ ok: true as const }),
  syncStewardSessionCookie: () => Promise.resolve(),
}));

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/dashboard",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

vi.mock("../../lib/steward-oauth-url", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/steward-oauth-url")
  >("../../lib/steward-oauth-url");
  return {
    ...actual,
    createStewardPkcePair: async () => {
      if (oauthState.pkceError) throw oauthState.pkceError;
      return { verifier: "verifier", challenge: "challenge" };
    },
    storeStewardPkceVerifier: () => oauthState.storeVerifier,
    buildStewardOAuthAuthorizeUrl: () =>
      "https://api.example.test/steward/auth/oauth/google/authorize",
  };
});

import StewardLoginSection from "./steward-login-section";

function renderSection(initialEntry = "/login") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

function makePopup() {
  return {
    closed: false,
    location: { href: "" },
    opener: window,
    close: vi.fn(),
  } as unknown as Window;
}

describe("StewardLoginSection OAuth launch", () => {
  beforeEach(() => {
    oauthState.popup = makePopup();
    oauthState.pkceError = null;
    oauthState.preOpenCalls = 0;
    oauthState.storeVerifier = true;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("navigates a pre-opened desktop popup after PKCE resolves", async () => {
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Google" }));

    await waitFor(() =>
      expect((oauthState.popup?.location as Location).href).toContain(
        "/steward/auth/oauth/google/authorize",
      ),
    );
    expect(oauthState.popup?.opener).toBeNull();
    expect(oauthState.preOpenCalls).toBe(1);
  });

  it("reuses the device-login surface instead of opening a nested popup", async () => {
    renderSection("/login?returnTo=%2Fauth%2Fcli-login%3Fsession%3Dsession-1");

    fireEvent.click(await screen.findByRole("button", { name: "Google" }));

    expect(oauthState.preOpenCalls).toBe(0);
  });

  it("closes the popup when browser storage cannot save the verifier", async () => {
    oauthState.storeVerifier = false;
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Google" }));

    await waitFor(() =>
      expect(screen.getByText(/browser storage is unavailable/i)).toBeTruthy(),
    );
    expect(oauthState.popup?.close).toHaveBeenCalledOnce();
  });

  it("closes the popup when PKCE creation fails", async () => {
    oauthState.pkceError = new Error("crypto unavailable");
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Google" }));

    await waitFor(() =>
      expect(screen.getByText("crypto unavailable")).toBeTruthy(),
    );
    expect(oauthState.popup?.close).toHaveBeenCalledOnce();
  });
});
