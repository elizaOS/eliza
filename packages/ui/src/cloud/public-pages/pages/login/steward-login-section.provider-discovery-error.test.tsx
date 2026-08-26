/**
 * Verifies that a fresh Steward provider-discovery failure never fabricates an
 * email/passkey-only login surface. The boundary must stay explicit and a retry
 * must render the exact server-authorized provider set.
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

const harness = vi.hoisted(() => ({
  getProvidersCalls: 0,
}));

const LIVE_PROVIDERS = {
  passkey: true,
  email: true,
  sms: true,
  siwe: false,
  siws: false,
  google: true,
  discord: true,
  github: true,
  twitter: true,
  telegram: true,
  oauth: ["google", "discord", "github", "twitter"],
};

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => false,
  consumeStewardCodeFromQuery: () => null,
  consumeStewardOAuthStateFromCallback: () => null,
  stripLegacyTokenHashFromAddressBar: () => false,
  exchangeStewardCodeViaApi: () => new Promise(() => {}),
  recoverStewardSessionViaCookie: () => Promise.resolve(null),
  recoverStewardEmailSessionViaCookie: () => Promise.resolve(null),
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
      if (harness.getProvidersCalls === 1) {
        return Promise.reject(
          new Error("Provider service is temporarily unavailable"),
        );
      }
      return Promise.resolve(LIVE_PROVIDERS);
    }
    refreshSession() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: () =>
    Promise.resolve({ usable: true, reason: "available" }),
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
    peekStewardOAuthState: () => null,
  };
});

vi.mock("../../lib/steward-oauth-url", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/steward-oauth-url")
  >("../../lib/steward-oauth-url");
  return {
    ...actual,
    consumeStewardPkceVerifier: () => null,
    buildStewardOAuthRedirectUri: () => "https://app.example.test/login",
  };
});

vi.mock("../../lib/login-return-to", () => ({
  resolveLoginReturnTo: () => "/cloud",
  consumePendingOAuthReturnTo: () => null,
  storePendingOAuthReturnTo: () => undefined,
}));

import StewardLoginSection from "./steward-login-section";

function renderSection() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
}

describe("StewardLoginSection provider discovery truth", () => {
  beforeEach(() => {
    harness.getProvidersCalls = 0;
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("fails visibly without a fabricated provider subset and retries live discovery", async () => {
    renderSection();

    expect(
      await screen.findByText("Sign-in options couldn't load"),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button", { name: "Passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Magic Link" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Google" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry sign-in options" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Google" })).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Discord" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "X" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Telegram" })).toBeTruthy();
    expect(harness.getProvidersCalls).toBe(2);
  });
});
