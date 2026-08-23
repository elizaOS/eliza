/** Verifies the PLAYWRIGHT_TEST_AUTH-only "local test account" sign-in on StewardLoginSection through the package's configured test harness (jsdom, Steward SDK doubled, fetch stubbed). */
// @vitest-environment jsdom

/**
 * The local test-account button is a development shortcut that must stay
 * invisible unless BOTH the Playwright test-auth flag and a configured local
 * API key are present, and when used it must trade that key for a test session
 * via `/api/test/auth/session`, plant the readable marker cookie that
 * `useSessionAuth` recognises, persist the key as the Steward token, and
 * surface server rejections verbatim instead of minting a fake session.
 */

import { readStoredStewardToken } from "@elizaos/shared/steward-session-client";
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

const sessionSpies = vi.hoisted(() => ({
  sync: vi.fn(),
  recover: vi.fn(),
  recoverEmail: vi.fn(),
  hasAuthedCookie: vi.fn(),
}));

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
        google: false,
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

vi.mock("@elizaos/shared/steward-session-client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@elizaos/shared/steward-session-client")
  >()),
  hasStewardAuthedCookie: sessionSpies.hasAuthedCookie,
}));

vi.mock("../../lib/steward-email-login", () => ({
  StewardEmailLoginError: class StewardEmailLoginError extends Error {
    status: number;
    code: string | null;
    constructor(message: string, status: number, code: string | null) {
      super(message);
      this.name = "StewardEmailLoginError";
      this.status = status;
      this.code = code;
    }
  },
  startStewardEmailLogin: vi.fn(),
  verifyStewardEmailSignInCode: vi.fn(),
  pollStewardEmailSignInStatus: vi.fn(),
}));

vi.mock("../../lib/steward-session", () => ({
  hasStewardOAuthCallbackInUrl: () => false,
  consumeStewardCodeFromQuery: () => null,
  stripLegacyTokenHashFromAddressBar: () => false,
  exchangeStewardCodeViaApi: vi.fn(),
  recoverStewardEmailSessionViaCookie: sessionSpies.recoverEmail,
  recoverStewardSessionViaCookie: sessionSpies.recover,
  refreshStewardSessionViaCookie: vi.fn(),
  syncStewardSessionCookie: sessionSpies.sync,
}));

vi.mock("../../lib/steward-email-login-complete", () => ({
  subscribeStewardEmailLoginComplete: vi.fn(() => vi.fn()),
}));

const LOCAL_KEY = "eliza_local_test_key_0123456789abcdef";
const BUTTON_NAME = /Continue with local test account/i;

function setCookie(pair: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom must reset the synchronous cookie jar the production marker write targets.
  document.cookie = pair;
}

function hasTestAuthMarker(): boolean {
  return document.cookie
    .split(";")
    .some((part) => part.trim() === "eliza-test-auth=1");
}

/**
 * The flag and key are read once at module evaluation, so each scenario
 * stubs the env first and then loads a fresh copy of the component.
 */
async function renderSectionWithEnv(env: {
  testAuth?: string;
  localKey?: string;
}) {
  vi.resetModules();
  vi.stubEnv("VITE_PLAYWRIGHT_TEST_AUTH", env.testAuth ?? "");
  vi.stubEnv("VITE_LOCAL_DEDICATED_TEST_API_KEY", env.localKey ?? "");
  vi.stubEnv("NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH", "");
  vi.stubEnv("NEXT_PUBLIC_LOCAL_DEDICATED_TEST_API_KEY", "");
  const { default: StewardLoginSection } = await import(
    "./steward-login-section"
  );
  const rendered = render(
    <MemoryRouter initialEntries={["/login?returnTo=%2Fcloud%2Fagents"]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return rendered;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("StewardLoginSection local test account sign-in", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setCookie("eliza-test-auth=; Max-Age=0; Path=/");
    sessionSpies.sync.mockResolvedValue(undefined);
    sessionSpies.recover.mockResolvedValue({ ok: true });
    sessionSpies.recoverEmail.mockResolvedValue({ ok: true });
    sessionSpies.hasAuthedCookie.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("stays hidden when test auth is armed but no local key is configured", async () => {
    await renderSectionWithEnv({ testAuth: "true" });
    await screen.findByPlaceholderText("you@example.com");
    expect(screen.queryByRole("button", { name: BUTTON_NAME })).toBeNull();
  });

  it("stays hidden when a local key exists but test auth is not armed", async () => {
    await renderSectionWithEnv({ localKey: LOCAL_KEY });
    await screen.findByPlaceholderText("you@example.com");
    expect(screen.queryByRole("button", { name: BUTTON_NAME })).toBeNull();
  });

  it("trades the configured key for a test session and plants the marker cookie", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          { token: "test-session-token", cookieName: "eliza-test-session" },
          200,
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const syncEvents: Event[] = [];
    window.addEventListener("steward-token-sync", (event) =>
      syncEvents.push(event),
    );

    await renderSectionWithEnv({ testAuth: "true", localKey: LOCAL_KEY });
    fireEvent.click(await screen.findByRole("button", { name: BUTTON_NAME }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(input)).toMatch(/\/api\/test\/auth\/session$/);
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${LOCAL_KEY}`,
    );

    await waitFor(() => expect(readStoredStewardToken()).toBe(LOCAL_KEY));
    expect(hasTestAuthMarker()).toBe(true);
    expect(syncEvents.length).toBeGreaterThan(0);
  });

  it("surfaces the server rejection and leaves no session behind", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "Invalid API key" }, 401)),
    );

    await renderSectionWithEnv({ testAuth: "true", localKey: LOCAL_KEY });
    fireEvent.click(await screen.findByRole("button", { name: BUTTON_NAME }));

    expect(await screen.findByText("Invalid API key")).toBeTruthy();
    expect(readStoredStewardToken()).toBeNull();
    expect(hasTestAuthMarker()).toBe(false);
  });

  it("reports a non-JSON failure body without minting a session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>gateway timeout</html>", { status: 504 }),
      ),
    );

    await renderSectionWithEnv({ testAuth: "true", localKey: LOCAL_KEY });
    fireEvent.click(await screen.findByRole("button", { name: BUTTON_NAME }));

    expect(
      await screen.findByText("Could not start the local Cloud test session."),
    ).toBeTruthy();
    expect(readStoredStewardToken()).toBeNull();
    expect(hasTestAuthMarker()).toBe(false);
  });
});
