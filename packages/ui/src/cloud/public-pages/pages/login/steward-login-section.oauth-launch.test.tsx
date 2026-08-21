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
  storedVerifierArgs: [] as Array<{ verifier: string; state?: string }>,
  authorizeUrlOptions: [] as Array<Record<string, unknown>>,
  telegramSignIns: [] as Array<{
    payload: Record<string, unknown>;
    config: Record<string, unknown>;
  }>,
  syncedSessions: [] as Array<unknown[]>,
  storedToken: null as string | null,
}));

vi.mock("@elizaos/shared/steward-session-client", async () => {
  const actual = await vi.importActual<
    typeof import("@elizaos/shared/steward-session-client")
  >("@elizaos/shared/steward-session-client");
  return {
    ...actual,
    hasStewardAuthedCookie: () => false,
    readStoredStewardToken: () => oauthState.storedToken,
    writeStoredStewardToken: (token: string) => {
      oauthState.storedToken = token;
    },
    generateStewardOAuthState: () => "state-1",
    buildStewardOAuthAuthorizeUrl: (
      provider: string,
      _redirectUri: string,
      options: Record<string, unknown>,
    ) => {
      oauthState.authorizeUrlOptions.push(options);
      return `https://api.example.test/steward/auth/oauth/${provider}/authorize`;
    },
  };
});

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
        twitter: true,
        telegram: true,
        oauth: ["google", "discord", "github", "twitter", "apple"],
      });
    }
    refreshSession() {
      return Promise.resolve(null);
    }
    signInWithTelegram(
      payload: Record<string, unknown>,
      config: Record<string, unknown>,
    ) {
      oauthState.telegramSignIns.push({ payload, config });
      return Promise.resolve({
        token: "telegram-token",
        refreshToken: "telegram-refresh",
        expiresIn: 900,
        user: { id: "telegram-user", email: null },
      });
    }
  },
}));

vi.mock("./telegram-login-widget", () => ({
  TelegramLoginCancelledError: class TelegramLoginCancelledError extends Error {},
  getConfiguredTelegramBotId: () => "7684336618",
  requestTelegramLogin: () =>
    Promise.resolve({
      id: 42,
      first_name: "Eliza",
      auth_date: 1_787_000_000,
      hash: "signed-payload",
    }),
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
  stripLegacyTokenHashFromAddressBar: () => false,
  exchangeStewardCodeViaApi: () => Promise.resolve({}),
  recoverStewardSessionViaCookie: () => Promise.resolve(null),
  refreshStewardSessionViaCookie: () => Promise.resolve({ ok: true as const }),
  syncStewardSessionCookie: (...args: unknown[]) => {
    oauthState.syncedSessions.push(args);
    return Promise.resolve();
  },
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
    storeStewardPkceVerifier: (verifier: string, state?: string) => {
      oauthState.storedVerifierArgs.push({ verifier, state });
      return oauthState.storeVerifier;
    },
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
    oauthState.storedVerifierArgs = [];
    oauthState.authorizeUrlOptions = [];
    oauthState.telegramSignIns = [];
    oauthState.syncedSessions = [];
    oauthState.storedToken = null;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    if (originalLocationDescriptor) {
      Object.defineProperty(window, "location", originalLocationDescriptor);
    }
  });

  it.each([
    ["Google", "google"],
    ["Discord", "discord"],
    ["GitHub", "github"],
    ["X", "twitter"],
    ["Apple", "apple"],
  ])(
    "navigates the current document for %s without opening a popup",
    async (providerLabel, provider) => {
      const openSpy = vi.spyOn(window, "open");
      renderSection();

      fireEvent.click(
        await screen.findByRole("button", { name: providerLabel }),
      );

      await waitFor(() =>
        expect(window.location.href).toBe(
          `https://api.example.test/steward/auth/oauth/${provider}/authorize`,
        ),
      );
      expect(openSpy).not.toHaveBeenCalled();
    },
  );

  it("keeps X as the accessible name without repeating it beside the logo", async () => {
    renderSection();

    const xButton = await screen.findByRole("button", { name: "X" });
    expect(xButton.textContent).toBe("");
    expect(xButton.querySelector("svg")).toBeTruthy();
  });

  it("sends the PKCE challenge and a stashed OAuth state at authorize time", async () => {
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Google" }));

    await waitFor(() =>
      expect(window.location.href).toContain("/steward/auth/oauth/"),
    );
    expect(oauthState.storedVerifierArgs).toEqual([
      { verifier: "verifier", state: "state-1" },
    ]);
    expect(oauthState.authorizeUrlOptions).toHaveLength(1);
    expect(oauthState.authorizeUrlOptions[0]).toMatchObject({
      codeChallenge: "challenge",
      state: "state-1",
    });
  });

  it("exchanges a signed Telegram widget payload and syncs the Cloud session", async () => {
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Telegram" }));

    await waitFor(() => expect(oauthState.telegramSignIns).toHaveLength(1));
    expect(oauthState.telegramSignIns[0]).toMatchObject({
      payload: {
        id: 42,
        auth_date: 1_787_000_000,
        hash: "signed-payload",
      },
      config: { tenantId: "elizacloud" },
    });
    await waitFor(() =>
      expect(oauthState.syncedSessions).toEqual([
        ["telegram-token", "telegram-refresh"],
      ]),
    );
  });

  it("releases the OAuth provider lock after a back-forward cache restoration", async () => {
    renderSection();

    fireEvent.click(await screen.findByRole("button", { name: "Google" }));

    await waitFor(() =>
      expect(window.location.href).toContain(
        "/steward/auth/oauth/google/authorize",
      ),
    );
    expect(
      (screen.getByRole("button", { name: "Google" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    const historyRestore = new Event("pageshow");
    Object.defineProperty(historyRestore, "persisted", { value: true });
    fireEvent(window, historyRestore);

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Google" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(
      (screen.getByRole("button", { name: "Discord" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "GitHub" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

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
