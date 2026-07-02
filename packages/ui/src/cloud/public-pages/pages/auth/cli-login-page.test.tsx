// @vitest-environment jsdom

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

function resetSessionAuth() {
  sessionAuthRef.current = {
    ready: true,
    authenticated: false,
    user: null,
  };
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

  it("completes the session when authenticated: POSTs /complete, notifies the opener, shows success, never redirects or script-closes", async () => {
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
      "*",
    );
    expect(
      screen
        .getByRole("link", { name: "Continue to dashboard" })
        .getAttribute("href"),
    ).toBe("/");
    expect(screen.queryByText("API Key Details")).toBeNull();
    expect(screen.queryByText("ek_live_abc")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Window" })).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
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
