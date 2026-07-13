// @vitest-environment jsdom

/**
 * `CliLoginPage` device-login flow: an unauthenticated visitor is redirected
 * straight to /login (no CLI interstitial) with a per-session guard so it never
 * loops; an authenticated visitor POSTs /complete, notifies the opener, and
 * returns app-launched sessions to their sanitized return target while keeping
 * the success screen as the terminal/manual fallback; a missing session id or a
 * completion failure renders the error panel with no POST. The router,
 * session-auth hook, api-client, Steward provider, and i18n are doubled.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- collaborator doubles (hoisted so vi.mock factories can close over them) ---

const navigateMock = vi.hoisted(() => vi.fn());
const searchParamsRef = vi.hoisted(() => ({
  current: new URLSearchParams("session=sess-1"),
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}));

const sessionAuthRef = vi.hoisted(() => ({
  current: {
    ready: true,
    authenticated: false,
    user: null as { id: string; email: string } | null,
  },
}));
vi.mock("../../../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionAuthRef.current,
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/api-client", () => {
  // Mirror the real ApiError signature (status, code, message, body?) so the
  // page's `error instanceof ApiError && error.status === 401` check works.
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly body?: unknown,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return { apiFetch: apiFetchMock, ApiError };
});

const clearStaleStewardSession = vi.hoisted(() => vi.fn());
vi.mock("../../../shell/StewardProvider", () => ({
  clearStaleStewardSession,
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

import { ApiError } from "../../../lib/api-client";
import CliLoginPage from "./cli-login-page";

const GUARD_KEY = "eliza-cloud-cli-login-autosignin:sess-1";
const SIGN_IN_HREF = `/login?returnTo=${encodeURIComponent(
  "/auth/cli-login?session=sess-1",
)}`;
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);

function resetSessionAuth() {
  sessionAuthRef.current = {
    ready: true,
    authenticated: false,
    user: null,
  };
}

function stubLocationReplace(): ReturnType<typeof vi.fn> {
  const replace = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      origin: "https://elizacloud.ai",
      replace,
    },
  });
  return replace;
}

function restoreLocation(): void {
  if (originalLocationDescriptor) {
    Object.defineProperty(window, "location", originalLocationDescriptor);
  }
}

beforeEach(() => {
  navigateMock.mockReset();
  apiFetchMock.mockReset();
  clearStaleStewardSession.mockReset();
  searchParamsRef.current = new URLSearchParams("session=sess-1");
  resetSessionAuth();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  restoreLocation();
  vi.restoreAllMocks();
  delete (window as { opener?: unknown }).opener;
});

describe("CliLoginPage", () => {
  it("auto-redirects an unauthenticated visitor straight to /login (no CLI interstitial) and arms the per-session guard", async () => {
    // No window.opener (not script-closable): the page must never offer a
    // "Close Window" button nor call window.close().
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    expect((window as { opener?: unknown }).opener).toBeUndefined();

    render(<CliLoginPage />);

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(SIGN_IN_HREF, {
        replace: true,
      }),
    );
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(GUARD_KEY)).toBe("1");
    // Renders the neutral "Signing in" state, never the old CLI panel/button.
    expect(screen.getByText("Signing in")).toBeTruthy();
    expect(screen.queryByText("CLI Authentication")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign In" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Window" })).toBeNull();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("does NOT redirect again when the guard is already set — shows the manual sign-in fallback (loop-safety)", async () => {
    sessionStorage.setItem(GUARD_KEY, "1");

    render(<CliLoginPage />);

    // Give any effect a tick to (not) fire.
    await Promise.resolve();
    expect(navigateMock).not.toHaveBeenCalled();
    const link = screen.getByRole("link", { name: /sign in/i });
    expect(link.getAttribute("href")).toBe(SIGN_IN_HREF);
  });

  it("completes authenticated terminal/manual sessions with the success fallback", async () => {
    sessionAuthRef.current = {
      ready: true,
      authenticated: true,
      user: { id: "u1", email: "a@b.co" },
    };
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    const postMessage = vi.fn();
    Object.defineProperty(window, "opener", {
      value: { postMessage },
      configurable: true,
    });
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    render(<CliLoginPage />);

    await waitFor(() =>
      expect(screen.getByText("Authentication Complete!")).toBeTruthy(),
    );
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/auth/cli-session/sess-1/complete",
      expect.objectContaining({ method: "POST" }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      { type: "eliza-cloud-auth-complete", sessionId: "sess-1" },
      window.location.origin,
    );
    expect(screen.getByRole("button", { name: "Close window" })).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: "Continue to dashboard" }),
    ).toBeNull();
    expect(screen.queryByText("API Key Details")).toBeNull();
    expect(screen.queryByText("ek_live_abc")).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("redirects authenticated app-launched sessions back to the sanitized returnTo", async () => {
    searchParamsRef.current = new URLSearchParams({
      session: "sess-1",
      returnTo: "http://localhost:2138/chat?firstRun=1",
    });
    sessionAuthRef.current = {
      ready: true,
      authenticated: true,
      user: { id: "u1", email: "a@b.co" },
    };
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    const postMessage = vi.fn();
    Object.defineProperty(window, "opener", {
      value: { postMessage },
      configurable: true,
    });
    const replace = stubLocationReplace();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    render(<CliLoginPage />);

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "http://localhost:2138/chat?firstRun=1",
      ),
    );
    expect(postMessage).toHaveBeenCalledWith(
      { type: "eliza-cloud-auth-complete", sessionId: "sess-1" },
      "http://localhost:2138",
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Returning to app")).toBeTruthy();
    expect(screen.queryByText("Authentication Complete!")).toBeNull();
  });

  it("allows the production apex app as a returnTo target", async () => {
    searchParamsRef.current = new URLSearchParams({
      session: "sess-1",
      returnTo: "https://elizacloud.ai/chat?elizaCloudLogin=complete",
    });
    sessionAuthRef.current = {
      ready: true,
      authenticated: true,
      user: { id: "u1", email: "a@b.co" },
    };
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    const replace = stubLocationReplace();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    render(<CliLoginPage />);

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "https://elizacloud.ai/chat?elizaCloudLogin=complete",
      ),
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Returning to app")).toBeTruthy();
    expect(screen.queryByText("Authentication Complete!")).toBeNull();
  });

  it("ignores untrusted returnTo origins and keeps the success fallback", async () => {
    searchParamsRef.current = new URLSearchParams({
      session: "sess-1",
      returnTo: "https://evil.example.test/chat",
    });
    sessionAuthRef.current = {
      ready: true,
      authenticated: true,
      user: { id: "u1", email: "a@b.co" },
    };
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    const replace = stubLocationReplace();

    render(<CliLoginPage />);

    await waitFor(() =>
      expect(screen.getByText("Authentication Complete!")).toBeTruthy(),
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("renders the error panel when the session id is missing — no POST, no redirect, no dead close button", async () => {
    searchParamsRef.current = new URLSearchParams("");

    render(<CliLoginPage />);

    expect(
      screen.getByText("Invalid authentication link. Missing session ID."),
    ).toBeTruthy();
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close Window" })).toBeNull();
  });

  it("surfaces a completion failure as the error panel", async () => {
    sessionAuthRef.current = {
      ready: true,
      authenticated: true,
      user: { id: "u1", email: "a@b.co" },
    };
    apiFetchMock.mockRejectedValue(new Error("boom"));

    render(<CliLoginPage />);

    await waitFor(() =>
      expect(screen.getByText("Authentication Error")).toBeTruthy(),
    );
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close Window" })).toBeNull();
  });

  it("clears the stale Steward session on a 401 during completion", async () => {
    sessionAuthRef.current = {
      ready: true,
      authenticated: true,
      user: { id: "u1", email: "a@b.co" },
    };
    apiFetchMock.mockRejectedValue(new ApiError(401, "unauthorized", "nope"));

    render(<CliLoginPage />);

    await waitFor(() => expect(clearStaleStewardSession).toHaveBeenCalled());
  });
});

describe("CliLoginPage short-viewport scroll", () => {
  // Every CliLoginPanel state (loading, success "Authentication Complete!",
  // error) is a full-viewport centered card. On short screens (Light Phone III,
  // 1080×1240) a flex `justify-center` pins the card center above scrollTop 0,
  // hiding the action buttons below an unreachable fold. The panel must be
  // `overflow-y-auto` with the card `my-auto`. jsdom can't measure layout, so
  // scan the source — same idiom as login-page.safe-area.test.tsx.
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "cli-login-page.tsx"),
    "utf8",
  );

  it("makes the panel region scroll instead of clipping when it exceeds the viewport", () => {
    expect(
      /min-h-\[100dvh\][^"]*overflow-y-auto/.test(SRC),
      "the CliLoginPanel wrapper must be overflow-y-auto to scroll when taller than the viewport",
    ).toBe(true);
  });

  it("centers the card with my-auto (not a parent justify-center that clips the top)", () => {
    expect(
      /\bmy-auto\b[^"]*\bmax-w-md\b/.test(SRC),
      "the panel card must center via my-auto so its top stays reachable while scrolling",
    ).toBe(true);
    expect(
      /min-h-\[100dvh\][^"]*items-center justify-center/.test(SRC),
      "the panel must not use the top-clipping items-center justify-center centering",
    ).toBe(false);
  });
});
