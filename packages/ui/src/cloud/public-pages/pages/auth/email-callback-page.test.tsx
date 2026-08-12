/** Verifies EmailCallbackPage through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * `EmailCallbackPage` mounts the magic-link callback inside `StewardAuthProvider`
 * so the verify actually runs instead of dead-ending on "unavailable". The
 * Steward provider, i18n provider, page-title hook, session helper, and
 * authorize-return/brand-button are doubled to isolate the mount.
 */

import { StewardApiError } from "@stwd/sdk";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callbackState = vi.hoisted(() => ({
  verifyEmailCallback:
    vi.fn<
      (
        token: string,
        email: string,
      ) => Promise<{ token: string; refreshToken?: string }>
    >(),
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
            isAuthenticated: false,
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
  syncStewardSessionCookie: vi.fn(),
}));
vi.mock("../../../../cloud-ui/components/auth/authorize-return", () => ({
  readStoredAppAuthorizeReturnTo: () => null,
  clearStoredAppAuthorizeReturnTo: () => {},
}));
vi.mock("../../../../cloud-ui/components/brand/brand-button", () => ({
  BrandButton: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

import EmailCallbackPage from "./email-callback-page";

beforeEach(() => {
  callbackState.verifyEmailCallback.mockReset();
});

afterEach(() => {
  cleanup();
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

  it("rejects an incomplete callback without calling the consume endpoint", async () => {
    render(
      <MemoryRouter initialEntries={["/auth/callback/email?email=a%40b.co"]}>
        <EmailCallbackPage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(
        "This sign-in link is missing its token or email.",
      ),
    ).toBeTruthy();
    expect(callbackState.verifyEmailCallback).not.toHaveBeenCalled();
  });
});
