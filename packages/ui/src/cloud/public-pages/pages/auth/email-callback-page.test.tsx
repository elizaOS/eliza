/** Verifies EmailCallbackPage through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * `EmailCallbackPage` mounts the magic-link callback inside `StewardAuthProvider`
 * so the verify actually runs instead of dead-ending on "unavailable". The
 * Steward provider, i18n provider, page-title hook, session helper, and
 * authorize-return module are doubled to isolate the mount.
 */

import { StewardApiError } from "@stwd/sdk";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callbackState = vi.hoisted(() => ({
  verifyEmailCallback:
    vi.fn<
      (
        token: string,
        email: string,
      ) => Promise<{ token: string; refreshToken?: string }>
    >(),
  resend: vi.fn(),
  publishComplete: vi.fn(),
  isAuthenticated: false,
}));

const sessionSpies = vi.hoisted(() => ({
  sync: vi.fn(),
}));

// Stub StewardAuthProvider with a marker that ALSO supplies the Steward context
// — what the real provider does once its runtime mounts. This lets the test
// assert both halves: (a) the callback renders INSIDE the self-mounted
// provider, and (b) the context reaches it so the magic-link verify runs rather
// than hitting the "Sign-in is unavailable" dead-end that a provider-less
// public route produces (#9881-class).
vi.mock("../../../shell/StewardProvider", async () => {
  const { createContext } = await import("react");
  const LocalStewardAuthContext = createContext<unknown>(null);
  return {
    LocalStewardAuthContext,
    StewardAuthProvider: ({ children }: { children: ReactNode }) => (
      <div data-testid="steward-auth-provider">
        <LocalStewardAuthContext.Provider
          value={{
            isAuthenticated: callbackState.isAuthenticated,
            isLoading: false,
            user: null,
            session: null,
            signOut: () => {},
            getToken: () => "",
            verifyEmailCallback: callbackState.verifyEmailCallback,
          }}
        >
          {children}
        </LocalStewardAuthContext.Provider>
      </div>
    ),
  };
});

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));
vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));
vi.mock("../../lib/steward-session", () => ({
  syncStewardSessionCookie: sessionSpies.sync,
}));
vi.mock("../../lib/steward-email-login", () => ({
  startStewardEmailLogin: callbackState.resend,
}));
vi.mock("../../lib/steward-email-login-complete", () => ({
  publishStewardEmailLoginComplete: callbackState.publishComplete,
}));
vi.mock("../../../shell/steward-config", () => ({
  configuredStewardTenantId: () => "elizacloud",
  DEFAULT_STEWARD_TENANT_ID: "elizacloud",
}));
vi.mock("../../../shell/steward-url", () => ({
  resolveBrowserStewardApiUrl: () => "https://api.example.test/steward",
}));
vi.mock("../../../../cloud-ui/components/auth/authorize-return", () => ({
  APP_AUTHORIZE_PATH: "/app-auth/authorize",
  readStoredAppAuthorizeReturnTo: () => null,
  clearStoredAppAuthorizeReturnTo: () => {},
}));

import { storePendingOAuthReturnTo } from "../../lib/login-return-to";
import EmailCallbackPage, {
  classifyEmailCallbackDestination,
  resolveEmailCallbackDestination,
} from "./email-callback-page";

beforeEach(() => {
  callbackState.verifyEmailCallback.mockReset();
  callbackState.resend.mockReset();
  callbackState.resend.mockResolvedValue({
    expiresAt: Date.now() + 600_000,
    challengeId: "fresh-challenge",
    pollSecret: "fresh-secret",
  });
  callbackState.publishComplete.mockReset();
  callbackState.isAuthenticated = false;
  sessionSpies.sync.mockReset();
  sessionSpies.sync.mockResolvedValue(undefined);
  window.sessionStorage.clear();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete document.documentElement.dataset.emailCallbackDocument;
});

describe("EmailCallbackPage", () => {
  it("mounts the callback inside StewardAuthProvider so the magic-link verify runs (not the 'unavailable' dead-end)", async () => {
    callbackState.verifyEmailCallback.mockImplementation(
      () => new Promise(() => {}),
    );

    render(
      <MemoryRouter
        initialEntries={["/auth/callback/email?token=tok&email=a%40b.co"]}
      >
        <EmailCallbackPage />
      </MemoryRouter>,
    );

    // (a) the callback renders inside the self-mounted provider — drop the
    // wrapper and this marker is never rendered, so getByTestId throws.
    expect(screen.getByTestId("steward-auth-provider")).toBeTruthy();

    // (b) the Steward context reaches the page, so verify runs with the URL
    // token/email. Without the wrapper `auth` is null and this never fires —
    // the page dead-ends on "Sign-in is unavailable".
    await waitFor(() =>
      expect(callbackState.verifyEmailCallback).toHaveBeenCalledWith(
        "tok",
        "a@b.co",
      ),
    );
  });

  it("keeps one-time verification single-flight across provider remounts", async () => {
    callbackState.verifyEmailCallback.mockImplementation(
      () => new Promise(() => {}),
    );

    const firstMount = render(
      <MemoryRouter
        initialEntries={[
          "/auth/callback/email?token=strict-token&email=strict%40example.com",
        ]}
      >
        <EmailCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(callbackState.verifyEmailCallback).toHaveBeenCalledTimes(1),
    );
    firstMount.unmount();

    render(
      <MemoryRouter
        initialEntries={[
          "/auth/callback/email?token=strict-token&email=strict%40example.com",
        ]}
      >
        <EmailCallbackPage />
      </MemoryRouter>,
    );

    expect(callbackState.verifyEmailCallback).toHaveBeenCalledTimes(1);
    expect(callbackState.verifyEmailCallback).toHaveBeenCalledWith(
      "strict-token",
      "strict@example.com",
    );
  });

  it("identifies an upstream one-time-link rejection as expired or already used", async () => {
    callbackState.verifyEmailCallback.mockRejectedValue(
      new StewardApiError("Invalid or expired magic link", 410),
    );

    const firstMount = render(
      <MemoryRouter
        initialEntries={[
          "/auth/callback/email?token=used-token&email=used%40example.com",
        ]}
      >
        <EmailCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        screen.getByText(
          "That sign-in link expired or was already used. Please sign in again.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Invalid or expired magic link")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Resend sign-in email" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to login" }).getAttribute("href"),
    ).toBe("/login");

    firstMount.unmount();
    render(
      <MemoryRouter
        initialEntries={[
          "/auth/callback/email?token=used-token&email=used%40example.com",
        ]}
      >
        <EmailCallbackPage />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(callbackState.verifyEmailCallback).toHaveBeenCalledTimes(2),
    );
  });

  it("resends an expired callback as a fresh challenge and shows the cooldown", async () => {
    const user = userEvent.setup();
    callbackState.verifyEmailCallback.mockRejectedValue(
      new StewardApiError("expired", 410),
    );

    render(
      <MemoryRouter
        initialEntries={[
          "/auth/callback/email?token=expired-token&email=person%40example.com",
        ]}
      >
        <EmailCallbackPage />
      </MemoryRouter>,
    );

    await user.click(
      await screen.findByRole("button", { name: "Resend sign-in email" }),
    );

    await waitFor(() =>
      expect(callbackState.resend).toHaveBeenCalledWith(
        {
          baseUrl: "https://api.example.test/steward",
          tenantId: "elizacloud",
        },
        "person@example.com",
      ),
    );
    expect(
      await screen.findByText("A new sign-in email is on its way."),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Resend in 30s/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("publishes a token-free completion only after the shared cookie is synced", async () => {
    storePendingOAuthReturnTo(
      new URLSearchParams({ returnTo: "/get-started" }),
    );
    callbackState.verifyEmailCallback.mockResolvedValue({
      token: "private-session-token",
      refreshToken: "private-refresh-token",
    });

    render(
      <MemoryRouter
        initialEntries={[
          "/auth/callback/email?token=one-time-token&email=person%40example.com",
        ]}
      >
        <EmailCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(callbackState.publishComplete).toHaveBeenCalledWith(
        "person@example.com",
        "/get-started",
      ),
    );
    expect(sessionSpies.sync).toHaveBeenCalledWith(
      "private-session-token",
      "private-refresh-token",
    );
    expect(sessionSpies.sync.mock.invocationCallOrder[0]).toBeLessThan(
      callbackState.publishComplete.mock.invocationCallOrder[0],
    );
    expect(
      JSON.stringify(callbackState.publishComplete.mock.calls),
    ).not.toContain("private-session-token");
  });

  it("falls back safely when callback state contains a backslash authority", async () => {
    const hostile = JSON.stringify({
      returnTo: "/\\\\evil.example",
      expiresAt: Date.now() + 60_000,
    });
    window.sessionStorage.setItem("eliza.login.oauth.returnTo", hostile);
    window.localStorage.setItem("eliza.login.oauth.returnTo", hostile);
    callbackState.verifyEmailCallback.mockResolvedValue({
      token: "private-session-token",
    });

    render(
      <MemoryRouter
        initialEntries={[
          "/auth/callback/email?token=one-time-token&email=person%40example.com",
        ]}
      >
        <EmailCallbackPage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(callbackState.publishComplete).toHaveBeenCalledWith(
        "person@example.com",
        "/join",
      ),
    );
    expect(
      window.sessionStorage.getItem("eliza.login.oauth.returnTo"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("eliza.login.oauth.returnTo"),
    ).toBeNull();
  });

  it("rejects a replayed callback without broadcasting when this tab already has a session", async () => {
    callbackState.isAuthenticated = true;
    callbackState.verifyEmailCallback.mockRejectedValue(
      new StewardApiError("already used", 410),
    );

    render(
      <MemoryRouter
        initialEntries={[
          "/auth/callback/email?token=replayed-token&email=person%40example.com",
        ]}
      >
        <EmailCallbackPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(
        "That sign-in link expired or was already used. Please sign in again.",
      ),
    ).toBeTruthy();
    expect(callbackState.verifyEmailCallback).toHaveBeenCalledWith(
      "replayed-token",
      "person@example.com",
    );
    expect(sessionSpies.sync).not.toHaveBeenCalled();
    expect(callbackState.publishComplete).not.toHaveBeenCalled();
  });

  it("restores a pending messaging continuation after magic-link verification", async () => {
    expect(resolveEmailCallbackDestination(null, "/get-started")).toBe(
      "/get-started",
    );
    expect(
      resolveEmailCallbackDestination(
        "/app-auth/authorize?id=1",
        "/get-started",
      ),
    ).toBe("/app-auth/authorize?id=1");
  });

  it("classifies an app-authorization destination explicitly", () => {
    const { isAppAuthorization, isJoinFallback } =
      classifyEmailCallbackDestination("/app-auth/authorize?id=1");
    expect(isAppAuthorization).toBe(true);
    expect(isJoinFallback).toBe(false);
  });

  it("classifies the ordinary login fallback as /join, not authorization", () => {
    const { isAppAuthorization, isJoinFallback } =
      classifyEmailCallbackDestination("/join");
    expect(isAppAuthorization).toBe(false);
    expect(isJoinFallback).toBe(true);
  });

  it("classifies a neutral same-origin target as neither", () => {
    const { isAppAuthorization, isJoinFallback } =
      classifyEmailCallbackDestination("/get-started");
    expect(isAppAuthorization).toBe(false);
    expect(isJoinFallback).toBe(false);
  });

  it("does not treat an embedded or lookalike authorization path as app authorization", () => {
    for (const destination of [
      "/continue/app-auth/authorize",
      "/app-auth/authorize-extra",
      "/get-started?next=/app-auth/authorize",
    ]) {
      expect(classifyEmailCallbackDestination(destination)).toEqual({
        isAppAuthorization: false,
        isJoinFallback: false,
      });
    }
  });

  it("continues to a same-origin return path without replacing the document", async () => {
    const user = userEvent.setup();
    storePendingOAuthReturnTo(
      new URLSearchParams({ returnTo: "/get-started" }),
    );
    callbackState.verifyEmailCallback.mockResolvedValue({
      token: "verified-token",
    });
    document.documentElement.dataset.emailCallbackDocument = "survived";

    render(
      <MemoryRouter
        initialEntries={[
          "/auth/callback/email?token=navigation-token&email=navigation%40b.co",
        ]}
      >
        <Routes>
          <Route path="/auth/callback/email" element={<EmailCallbackPage />} />
          <Route path="/get-started" element={<div>continued in place</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Continue",
      }),
    );

    expect(await screen.findByText("continued in place")).toBeTruthy();
    expect(document.documentElement.dataset.emailCallbackDocument).toBe(
      "survived",
    );
  });

  it("rejects an incomplete callback and offers a safe keyboard-reachable recovery action", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={["/auth/callback/email"]}>
        <EmailCallbackPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(
        "This sign-in link is missing its token or email.",
      ),
    ).toBeTruthy();
    expect(await screen.findByRole("main")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "Sign-in failed" }),
    ).toBeTruthy();
    const recovery = screen.getByRole("link", { name: "Sign In Again" });
    expect(recovery.getAttribute("href")).toBe("/login");
    await user.tab();
    expect(document.activeElement).toBe(recovery);
    expect(callbackState.verifyEmailCallback).not.toHaveBeenCalled();
  });
});
