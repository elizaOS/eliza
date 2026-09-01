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
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const oauthState = vi.hoisted(() => ({
  nativePlatform: false,
  openedExternalUrls: [] as string[],
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

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => oauthState.nativePlatform,
    registerPlugin: () => ({}),
  },
  registerPlugin: () => ({}),
}));

vi.mock("../../../../utils/openExternalUrl", () => ({
  openExternalUrl: (url: string) => {
    oauthState.openedExternalUrls.push(url);
    return Promise.resolve(true);
  },
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
  configuredTelegramBotUsername: () => "elizastagingfelibot",
  TelegramLoginWidget: ({
    onAuth,
  }: {
    onAuth: (payload: Record<string, unknown>) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onAuth({
          id: 42,
          first_name: "Eliza",
          auth_date: 1_787_000_000,
          hash: "signed-payload",
        })
      }
    >
      Complete Telegram sign-in
    </button>
  ),
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

function renderSection(initialEntry = "/login") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

function renderSectionInStrictMode(initialEntry: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[initialEntry]}>
        <StewardLoginSection />
      </MemoryRouter>
    </StrictMode>,
  );
}

const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);

function stubHostedLoginLocation(href = "https://cloud.eliza.app/login"): void {
  const url = new URL(href);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      hash: "",
      hostname: url.hostname,
      href: url.toString(),
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
    },
  });
}

describe("StewardLoginSection OAuth launch", () => {
  beforeEach(() => {
    stubHostedLoginLocation();
    oauthState.nativePlatform = false;
    oauthState.openedExternalUrls = [];
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

  it("hands native provider intent to the browser before creating PKCE", async () => {
    oauthState.nativePlatform = true;
    stubHostedLoginLocation(
      "https://cloud.eliza.app/login?returnTo=%2Fapp-auth%2Fauthorize%3Fstate%3Douter-state",
    );
    renderSection(
      "/login?returnTo=%2Fapp-auth%2Fauthorize%3Fstate%3Douter-state",
    );

    fireEvent.click(await screen.findByRole("button", { name: "Google" }));

    await waitFor(() => expect(oauthState.openedExternalUrls).toHaveLength(1));
    const openedUrl = new URL(oauthState.openedExternalUrls[0]);
    expect(openedUrl.origin).toBe("https://cloud.eliza.app");
    expect(openedUrl.pathname).toBe("/login");
    expect(openedUrl.searchParams.get("nativeProvider")).toBe("google");
    expect(openedUrl.searchParams.get("returnTo")).toBe(
      "/app-auth/authorize?state=outer-state",
    );
    expect(oauthState.storedVerifierArgs).toEqual([]);
    expect(oauthState.authorizeUrlOptions).toEqual([]);
  });

  it("auto-launches a validated native provider intent once in the browser", async () => {
    const replaceState = vi
      .spyOn(window.history, "replaceState")
      .mockImplementation((_data, _unused, url) => {
        const next = new URL(String(url), window.location.origin);
        Object.assign(window.location, {
          hash: next.hash,
          href: next.toString(),
          pathname: next.pathname,
          search: next.search,
        });
      });
    stubHostedLoginLocation(
      "https://cloud.eliza.app/login?returnTo=%2Fapp-auth%2Fauthorize%3Fstate%3Douter-state&nativeProvider=google",
    );
    renderSectionInStrictMode(
      "/login?returnTo=%2Fapp-auth%2Fauthorize%3Fstate%3Douter-state&nativeProvider=google",
    );

    await waitFor(() =>
      expect(window.location.href).toContain(
        "/steward/auth/oauth/google/authorize",
      ),
    );
    expect(oauthState.storedVerifierArgs).toEqual([
      { verifier: "verifier", state: "state-1" },
    ]);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0]?.[2]).not.toContain("nativeProvider");
  });

  it("consumes an invalid provider intent without launching OAuth", async () => {
    const replaceState = vi.spyOn(window.history, "replaceState");
    stubHostedLoginLocation(
      "https://cloud.eliza.app/login?nativeProvider=javascript",
    );
    renderSection("/login?nativeProvider=javascript");

    await waitFor(() => expect(replaceState).toHaveBeenCalledTimes(1));
    expect(oauthState.storedVerifierArgs).toEqual([]);
    expect(oauthState.authorizeUrlOptions).toEqual([]);
    expect(oauthState.openedExternalUrls).toEqual([]);
  });

  it("does not re-open the browser when a marker reaches the native WebView", async () => {
    oauthState.nativePlatform = true;
    const replaceState = vi.spyOn(window.history, "replaceState");
    stubHostedLoginLocation(
      "https://cloud.eliza.app/login?nativeProvider=google",
    );
    renderSection("/login?nativeProvider=google");

    await waitFor(() => expect(replaceState).toHaveBeenCalledTimes(1));
    expect(oauthState.openedExternalUrls).toEqual([]);
    expect(oauthState.storedVerifierArgs).toEqual([]);
  });

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
    fireEvent.click(
      await screen.findByRole("button", { name: "Complete Telegram sign-in" }),
    );

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

  it.each([
    ["Google", "google"],
    ["Discord", "discord"],
    ["GitHub", "github"],
    ["X", "twitter"],
    ["Apple", "apple"],
  ])(
    "releases the %s OAuth lock after a back-forward cache restoration",
    async (providerLabel, provider) => {
      renderSection();

      fireEvent.click(
        await screen.findByRole("button", { name: providerLabel }),
      );

      await waitFor(() =>
        expect(window.location.href).toContain(
          `/steward/auth/oauth/${provider}/authorize`,
        ),
      );
      const providerButton = screen.getByRole("button", {
        name: providerLabel,
      }) as HTMLButtonElement;
      expect(providerButton.disabled).toBe(true);

      const historyRestore = new Event("pageshow");
      Object.defineProperty(historyRestore, "persisted", { value: true });
      fireEvent(window, historyRestore);

      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: providerLabel,
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
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
