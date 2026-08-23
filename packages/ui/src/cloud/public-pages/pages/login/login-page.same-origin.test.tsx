/**
 * Canonical app-host login rendering under jsdom, with Steward discovery and
 * SSO navigation isolated so the current-origin route decision is observable.
 */
// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://cloud.eliza.app/login?returnTo=%2Fchat"}

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const { redirectToSsoBridge } = vi.hoisted(() => ({
  redirectToSsoBridge: vi.fn(() => Promise.resolve(true)),
}));

const realLocation = window.location;

function setLocation(hostname: string, origin: string): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, hostname, origin },
  });
}

vi.mock("./passkey-capability", () => ({
  resolveWebPasskeyCapability: () =>
    Promise.resolve({ usable: false, reason: "native-without-bridge" }),
}));

vi.mock("@stwd/sdk", () => ({
  StewardAuth: class {
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
        oauth: [],
      });
    }
    getSession() {
      return null;
    }
    refreshSession() {
      return Promise.resolve(null);
    }
  },
}));

vi.mock("@elizaos/shared/steward-session-client", () => ({
  hasStewardAuthedCookie: () => false,
  readStoredStewardToken: () => null,
  writeStoredStewardToken: () => undefined,
  StewardSessionError: class extends Error {},
}));

vi.mock("../../lib/steward-session", () => ({
  consumeStewardCodeFromQuery: () => null,
  consumeStewardTokensFromHash: () => null,
  exchangeStewardCodeViaApi: () => Promise.resolve(null),
  hasStewardOAuthCallbackInUrl: () => false,
  recoverStewardSessionViaCookie: () => Promise.resolve(null),
  refreshStewardSessionViaCookie: () => Promise.resolve(null),
  stripLegacyTokenHashFromAddressBar: () => false,
  syncStewardSessionCookie: () => Promise.resolve(),
}));

vi.mock("../../../shell/steward-url", () => ({
  resolveBrowserStewardApiUrl: () => "https://api.example.test/steward",
}));

vi.mock("../../../shell/steward-config", () => ({
  configuredStewardTenantId: () => "elizacloud",
  DEFAULT_STEWARD_TENANT_ID: "elizacloud",
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

// The managed-cloud branch only shows itself when a handoff is actually
// available; with the real `shouldAutoBridgeToSso` it short-circuits back to
// the same local page an app host renders, and every assertion below would
// hold no matter which branch ran. Forcing it true makes the two outcomes
// distinguishable, so these tests fail when an app host is misrouted.
vi.mock("../../../sso-bridge/sso-bridge", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../sso-bridge/sso-bridge")>();
  return { ...actual, redirectToSsoBridge, shouldAutoBridgeToSso: () => true };
});

import LoginPage from "./login-page";
import "./steward-login-section";

afterEach(() => {
  cleanup();
  redirectToSsoBridge.mockClear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: realLocation,
  });
});

it("keeps canonical app-host login on the current origin", async () => {
  render(
    <MemoryRouter initialEntries={["/login?returnTo=%2Fchat"]}>
      <LoginPage />
    </MemoryRouter>,
  );

  expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  expect(
    await screen.findByRole("button", { name: /Magic Link/i }),
  ).toBeTruthy();
  expect(screen.queryByText("Taking you to Eliza sign in")).toBeNull();
  expect(redirectToSsoBridge).not.toHaveBeenCalled();
  expect(window.location.origin).toBe("https://cloud.eliza.app");
});

it("keeps canonical staging app-host login on the current origin", async () => {
  setLocation("cloud-staging.eliza.app", "https://cloud-staging.eliza.app");

  render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );

  expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  expect(
    await screen.findByRole("button", { name: /Magic Link/i }),
  ).toBeTruthy();
  expect(screen.queryByText("Taking you to Eliza sign in")).toBeNull();
  expect(redirectToSsoBridge).not.toHaveBeenCalled();
  expect(window.location.origin).toBe("https://cloud-staging.eliza.app");
});

it("normalizes a canonical app hostname before keeping login local", async () => {
  setLocation("CLOUD-STAGING.ELIZA.APP.", "https://cloud-staging.eliza.app");

  render(
    <MemoryRouter initialEntries={["/login"]}>
      <LoginPage />
    </MemoryRouter>,
  );

  expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  expect(
    await screen.findByRole("button", { name: /Magic Link/i }),
  ).toBeTruthy();
  expect(screen.queryByText("Taking you to Eliza sign in")).toBeNull();
  expect(redirectToSsoBridge).not.toHaveBeenCalled();
  expect(window.location.origin).toBe("https://cloud-staging.eliza.app");
});
