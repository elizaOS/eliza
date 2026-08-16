/** Verifies StewardLoginSection OAuth launch through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Exercises hosted OAuth current-document navigation and PKCE failure recovery
 * with an in-memory Steward provider boundary; no live OAuth service runs.
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
  pkceError: null as Error | null,
  storeVerifier: true,
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
        discord: true,
        github: true,
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
  recoverStewardSessionViaCookie: () => Promise.resolve(null),
  refreshStewardSessionViaCookie: () => Promise.resolve({ ok: true as const }),
  syncStewardSessionCookie: () => Promise.resolve(),
}));

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/cloud",
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
    buildStewardOAuthAuthorizeUrl: (provider: string) =>
      `https://api.example.test/steward/auth/oauth/${provider}/authorize`,
  };
});

import StewardLoginSection from "./steward-login-section";

function renderSection() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);

function stubHostedLoginLocation(): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      hash: "",
      hostname: "cloud.eliza.app",
      href: "https://cloud.eliza.app/login",
      origin: "https://cloud.eliza.app",
      pathname: "/login",
      search: "",
    },
  });
}

describe("StewardLoginSection OAuth launch", () => {
  beforeEach(() => {
    stubHostedLoginLocation();
    oauthState.pkceError = null;
    oauthState.storeVerifier = true;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    if (originalLocationDescriptor) {
      Object.defineProperty(window, "location", originalLocationDescriptor);
    }
  });

  it.each(["Google", "Discord", "GitHub"])(
    "navigates the current document for %s without opening a popup",
    async (providerLabel) => {
      const openSpy = vi.spyOn(window, "open");
      renderSection();

      fireEvent.click(
        await screen.findByRole("button", { name: providerLabel }),
      );

      await waitFor(() =>
        expect(window.location.href).toBe(
          `https://api.example.test/steward/auth/oauth/${providerLabel.toLowerCase()}/authorize`,
        ),
      );
      expect(openSpy).not.toHaveBeenCalled();
    },
  );

  it("keeps the form retryable when browser storage cannot save the verifier", async () => {
    oauthState.storeVerifier = false;
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Google" }));

    await waitFor(() =>
      expect(screen.getByText(/browser storage is unavailable/i)).toBeTruthy(),
    );
    expect(window.location.href).toBe("https://cloud.eliza.app/login");
    expect(
      (screen.getByRole("button", { name: "Google" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("keeps the form retryable when PKCE creation fails", async () => {
    oauthState.pkceError = new Error("crypto unavailable");
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Google" }));

    await waitFor(() =>
      expect(screen.getByText("crypto unavailable")).toBeTruthy(),
    );
    expect(window.location.href).toBe("https://cloud.eliza.app/login");
    expect(
      (screen.getByRole("button", { name: "Google" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
