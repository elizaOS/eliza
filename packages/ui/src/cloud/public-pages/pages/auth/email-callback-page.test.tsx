// @vitest-environment jsdom

/**
 * `EmailCallbackPage` mounts the magic-link callback inside `StewardAuthProvider`
 * so the verify actually runs instead of dead-ending on "unavailable". The
 * Steward provider, i18n provider, page-title hook, session helper, and
 * authorize-return/brand-button are doubled to isolate the mount.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// A never-resolving verify keeps the page in its "verifying" state — we only
// need to observe the verify was REACHED, not its outcome.
const { verifyEmailCallback } = vi.hoisted(() => ({
  verifyEmailCallback: vi.fn(
    (_token: string, _email: string) => new Promise(() => {}),
  ),
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
            verifyEmailCallback,
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

afterEach(() => {
  cleanup();
});

describe("EmailCallbackPage", () => {
  it("mounts the callback inside StewardAuthProvider so the magic-link verify runs (not the 'unavailable' dead-end)", async () => {
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
      expect(verifyEmailCallback).toHaveBeenCalledWith("tok", "a@b.co"),
    );
  });
});
