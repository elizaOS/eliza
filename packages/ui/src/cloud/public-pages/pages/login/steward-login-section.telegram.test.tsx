/**
 * Verifies the hosted login's Telegram intent gate and Steward session handoff
 * with a mocked provider boundary; no Telegram or Steward network runs.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  signInWithTelegram: vi.fn(),
  syncSessionCookie: vi.fn(),
  writeToken: vi.fn(),
  storedToken: null as string | null,
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
        sms: false,
        siwe: false,
        siws: false,
        google: false,
        discord: false,
        github: false,
        telegram: true,
        twitter: false,
        oauth: [],
      });
    }
    refreshSession() {
      return Promise.resolve(null);
    }
    signInWithTelegram(payload: unknown, config: unknown) {
      return harness.signInWithTelegram(payload, config);
    }
  },
  StewardApiError: class extends Error {},
}));

vi.mock("@elizaos/shared/steward-session-client", () => ({
  buildStewardOAuthAuthorizeUrl: vi.fn(),
  generateStewardOAuthState: vi.fn(),
  hasStewardAuthedCookie: () => false,
  peekStewardOAuthState: () => null,
  readStoredStewardToken: () => harness.storedToken,
  StewardSessionError: class extends Error {},
  writeStoredStewardToken: (token: string) => {
    harness.storedToken = token;
    return harness.writeToken(token);
  },
}));

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => false,
  consumeStewardCodeFromQuery: () => null,
  stripLegacyTokenHashFromAddressBar: () => false,
  exchangeStewardCodeViaApi: vi.fn(),
  recoverStewardEmailSessionViaCookie: () => Promise.resolve(null),
  recoverStewardSessionViaCookie: () => Promise.resolve(null),
  refreshStewardSessionViaCookie: () => Promise.resolve({ ok: true as const }),
  syncStewardSessionCookie: (...args: unknown[]) =>
    harness.syncSessionCookie(...args),
}));

vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: () =>
    Promise.resolve({ usable: false, reason: "native-without-bridge" }),
}));

vi.mock("../../../shell/steward-url", () => ({
  resolveBrowserStewardApiUrl: () => "https://api.example.test",
}));

vi.mock("../../../shell/steward-config", () => ({
  configuredStewardTenantId: () => "elizacloud-staging",
  DEFAULT_STEWARD_TENANT_ID: "elizacloud",
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
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
    consumeStewardPkceVerifier: () => null,
  };
});

import StewardLoginSection from "./steward-login-section";

describe("StewardLoginSection Telegram login", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_TELEGRAM_BOT_USERNAME", "elizastagingfelibot");
    harness.storedToken = null;
    harness.signInWithTelegram.mockResolvedValue({
      token: "steward-token",
      refreshToken: "refresh-token",
    });
    harness.syncSessionCookie.mockResolvedValue(undefined);
    harness.writeToken.mockResolvedValue(undefined);
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("loads the official widget only after intent and completes Cloud sync", async () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <StewardLoginSection />
      </MemoryRouter>,
    );

    expect(
      document.querySelector('script[src^="https://telegram.org/js/"]'),
    ).toBeNull();
    const telegramButton = await screen.findByRole("button", {
      name: "Telegram",
    });
    fireEvent.click(telegramButton);

    const telegramRegion = await screen.findByRole("group", {
      name: "Telegram sign-in",
    });
    await waitFor(() => expect(document.activeElement).toBe(telegramRegion));
    fireEvent.click(
      screen.getByRole("button", { name: "Use another sign-in method" }),
    );
    await waitFor(() => expect(document.activeElement).toBe(telegramButton));
    expect(
      document.querySelector('script[src^="https://telegram.org/js/"]'),
    ).toBeNull();

    fireEvent.click(telegramButton);

    const script = await waitFor(() => {
      const element = document.querySelector<HTMLScriptElement>(
        'script[src="https://telegram.org/js/telegram-widget.js?22"]',
      );
      expect(element).not.toBeNull();
      return element as HTMLScriptElement;
    });
    expect(script.getAttribute("data-telegram-login")).toBe(
      "elizastagingfelibot",
    );
    const callbackName = (script.getAttribute("data-onauth") ?? "").replace(
      "(user)",
      "",
    );
    const callback = (window as unknown as Record<string, unknown>)[
      callbackName
    ];
    if (typeof callback !== "function") {
      throw new Error("Telegram widget callback was not installed");
    }
    await act(async () => {
      callback({
        id: 123456,
        auth_date: 1_789_999_999,
        hash: "b".repeat(64),
        username: "telegram_user",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() =>
      expect(harness.signInWithTelegram).toHaveBeenCalledWith(
        expect.objectContaining({ id: 123456, username: "telegram_user" }),
        { tenantId: "elizacloud-staging" },
      ),
    );
    expect(harness.syncSessionCookie).toHaveBeenCalledWith(
      "steward-token",
      "refresh-token",
    );
    expect(harness.writeToken).toHaveBeenCalledWith("steward-token");
  });
});
