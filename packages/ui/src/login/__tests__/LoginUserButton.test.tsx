/**
 * <LoginUserButton /> branch coverage.
 *
 * The dropdown is gated behind `open` state (starts false) and the
 * click-outside listener runs in an effect, so SSR renders only the closed
 * trigger. We assert on the trigger derivation logic:
 *   - returns null when there is no user (and no session fallback)
 *   - derives display name + gravatar avatar from email
 *   - derives an initials avatar + truncated wallet when there is no email
 *   - falls back to session fields when auth.user is null (post-refresh)
 */

import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

const { LoginUserButton } = await import("../components/LoginUserButton.js");
const { LoginAuthContext } = await import("../provider.js");

function ctx(overrides: Record<string, unknown>): any {
  return {
    isAuthenticated: true,
    isLoading: false,
    user: null,
    session: null,
    providers: null,
    isProvidersLoading: false,
    signOut: () => {},
    getToken: () => null,
    activeTenantId: null,
    tenants: null,
    isTenantsLoading: false,
    switchTenant: async () => false,
    ...overrides,
  };
}

function render(value: unknown, props: Record<string, unknown> = {}) {
  return renderToString(
    React.createElement(
      LoginAuthContext.Provider,
      { value: value as React.ContextType<typeof LoginAuthContext> },
      React.createElement(LoginUserButton, props),
    ),
  );
}

describe("<LoginUserButton /> branch coverage", () => {
  test("renders nothing when there is no user and no session", () => {
    expect(render(ctx({ user: null, session: null }))).toBe("");
  });

  test("renders an email trigger with a gravatar avatar", () => {
    const html = render(
      ctx({ user: { id: "u1", email: "alice@example.com" } }),
    );
    expect(html).toContain("stwd-user-button__trigger");
    expect(html).toContain("alice@example.com");
    // gravatar avatar URL is derived from the email
    expect(html).toContain("gravatar.com/avatar/");
    expect(html).toContain("stwd-user-button__avatar");
  });

  test("renders an initials avatar + truncated wallet when there is no email", () => {
    const html = render(
      ctx({
        user: {
          id: "u1",
          email: "",
          walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
        },
      }),
      { showWallet: true },
    );
    // initials avatar (no gravatar img)
    expect(html).toContain("stwd-user-button__avatar--initials");
    expect(html).not.toContain("gravatar.com");
    // wallet truncated with the component's own 6/4 truncation + ellipsis char
    expect(html).toContain("0x1234");
  });

  test("falls back to session fields when auth.user is null (post-refresh)", () => {
    const html = render(
      ctx({
        user: null,
        session: { userId: "u9", email: "bob@example.com", address: "0xdead" },
      }),
    );
    expect(html).toContain("bob@example.com");
    expect(html).toContain("gravatar.com/avatar/");
  });

  test("derives initials from the email local part for the default-name path", () => {
    // No email, no wallet → displayName defaults to "User" → initial "U".
    const html = render(
      ctx({ user: { id: "u1", email: "", walletAddress: undefined } }),
    );
    expect(html).toContain("stwd-user-button__avatar--initials");
    // Initials circle should contain the uppercase first letter "U" of "User".
    expect(html).toContain(">U<");
  });

  test("dropdown is closed on initial SSR render (no Sign Out item visible)", () => {
    const html = render(
      ctx({ user: { id: "u1", email: "alice@example.com" } }),
    );
    // The dropdown (and its Sign Out item) only mounts when `open` is true.
    expect(html).not.toContain("Sign Out");
    // trigger advertises the closed state for a11y
    expect(html).toContain('aria-expanded="false"');
  });
});
