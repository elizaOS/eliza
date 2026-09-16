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

import {
  clearStoredStewardToken,
  readStoredStewardToken,
  registerStewardTokenPersistence,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_TOKEN_KEY,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
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
import StewardLoginSection from "./steward-login-section";

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

vi.mock("@elizaos/login", () => ({
  LoginAuth: class {
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
 * Each scenario stubs the build-time flag and key before mounting the
 * component so the supported configuration matrix stays explicit.
 */
function renderSectionWithEnv(env: { testAuth?: string; localKey?: string }) {
  vi.stubEnv("VITE_PLAYWRIGHT_TEST_AUTH", env.testAuth ?? "");
  vi.stubEnv("VITE_LOCAL_DEDICATED_TEST_API_KEY", env.localKey ?? "");
  vi.stubEnv("NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH", "");
  vi.stubEnv("NEXT_PUBLIC_LOCAL_DEDICATED_TEST_API_KEY", "");
  const rendered = render(
    <MemoryRouter initialEntries={["/login?returnTo=%2Fcloud%2Fagents"]}>
      <StewardLoginSection />
    </MemoryRouter>,
  );
  return rendered;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("StewardLoginSection local test account sign-in", {
  timeout: 20_000,
}, () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetStewardTabSessionAuthorityCoordinatorForTests();
    setCookie("eliza-test-auth=; Max-Age=0; Path=/");
    sessionSpies.sync.mockResolvedValue(undefined);
    sessionSpies.recover.mockResolvedValue({ ok: true });
    sessionSpies.recoverEmail.mockResolvedValue({ ok: true });
    sessionSpies.hasAuthedCookie.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    resetStewardTabSessionAuthorityCoordinatorForTests();
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

  it.each(["unmount", "pagehide", "replacement"])(
    "does not publish a delayed local session after %s",
    async (winner) => {
      const response = Promise.withResolvers<Response>();
      const fetchMock = vi.fn(
        (_input: RequestInfo | URL, _init?: RequestInit) => response.promise,
      );
      vi.stubGlobal("fetch", fetchMock);
      const view = renderSectionWithEnv({
        testAuth: "true",
        localKey: LOCAL_KEY,
      });
      fireEvent.click(await screen.findByRole("button", { name: BUTTON_NAME }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      if (winner === "unmount") view.unmount();
      if (winner === "pagehide") fireEvent(window, new Event("pagehide"));
      if (winner === "replacement")
        localStorage.setItem(STEWARD_TOKEN_KEY, "replacement-fixture");
      await act(async () => {
        response.resolve(
          jsonResponse({ token: "synthetic-local-session" }, 200),
        );
      });
      expect(readStoredStewardToken()).toBe(
        winner === "replacement" ? "replacement-fixture" : null,
      );
      expect(hasTestAuthMarker()).toBe(false);
      if (winner !== "replacement")
        expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    },
  );

  it("does not plant the authenticated marker if canonical persistence fails", async () => {
    const unregister = registerStewardTokenPersistence(async () => {
      throw new Error("Synthetic storage unavailable");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ token: "synthetic-local-session" }, 200),
      ),
    );
    try {
      renderSectionWithEnv({ testAuth: "true", localKey: LOCAL_KEY });
      fireEvent.click(await screen.findByRole("button", { name: BUTTON_NAME }));
      await screen.findByRole("alert");
      expect(readStoredStewardToken()).toBeNull();
      expect(hasTestAuthMarker()).toBe(false);
    } finally {
      unregister();
    }
  });

  it("orders a queued logout after the local cookie request and canonical publication", async () => {
    const response = Promise.withResolvers<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    renderSectionWithEnv({ testAuth: "true", localKey: LOCAL_KEY });
    fireEvent.click(await screen.findByRole("button", { name: BUTTON_NAME }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    let ended = false;
    const logout = clearStoredStewardToken().then(() => {
      ended = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    const endedBeforeResponse = ended;
    await act(async () => {
      response.resolve(jsonResponse({ token: "synthetic-local-session" }, 200));
      await logout;
    });
    expect(endedBeforeResponse).toBe(false);
    expect(readStoredStewardToken()).toBeNull();
  });

  it.each(["headers", "body"])(
    "bounds stalled response %s and leaves later sign-in usable",
    async (stage) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const response = Promise.withResolvers<Response>();
      let streamController:
        | ReadableStreamDefaultController<Uint8Array>
        | undefined;
      const streamed = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
        }),
      );
      const fetchMock = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) => {
          // Model fetch's abort contract for both headers and body consumption.
          init?.signal?.addEventListener(
            "abort",
            () => {
              const error = new DOMException("Aborted", "AbortError");
              if (stage === "headers") response.reject(error);
              else streamController?.error(error);
            },
            { once: true },
          );
          return stage === "headers"
            ? response.promise
            : Promise.resolve(streamed);
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      try {
        renderSectionWithEnv({ testAuth: "true", localKey: LOCAL_KEY });
        fireEvent.click(
          await screen.findByRole("button", { name: BUTTON_NAME }),
        );
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_001);
        });
        expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(screen.getByRole("alert")).toBeTruthy();
        expect(
          screen
            .getByRole("button", { name: BUTTON_NAME })
            .hasAttribute("disabled"),
        ).toBe(false);
        expect(hasTestAuthMarker()).toBe(false);
        await act(async () => {
          await writeStoredStewardToken("new-session-fixture");
        });
        expect(readStoredStewardToken()).toBe("new-session-fixture");
        expect(hasTestAuthMarker()).toBe(false);
      } finally {
        response.resolve(
          jsonResponse({ token: "synthetic-local-session" }, 200),
        );
        vi.useRealTimers();
      }
    },
  );
});
