/**
 * <LoginOAuthCallback /> initial-render coverage.
 *
 * Like LoginEmailCallback, all of the token-in-URL / code-in-URL / error
 * handling lives in a `useEffect` that reads `window.location.search` and
 * `localStorage`. SSR does not flush effects and the runner has no DOM, so we
 * cover the deterministic initial render (the "Completing … sign-in" loading
 * shell, optionally with the provider name) and the rules-of-hooks invariant.
 * The branch logic is exercised by the browser e2e suite.
 */

import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

const { LoginOAuthCallback } = await import(
  "../components/LoginOAuthCallback.js"
);
const { LoginAuthContext } = await import("../provider.js");

function ctx(overrides: Record<string, unknown> = {}): any {
  return {
    isAuthenticated: false,
    isLoading: false,
    user: null,
    session: null,
    ...overrides,
  };
}

function render(value: unknown, props: Record<string, unknown> = {}) {
  return renderToString(
    React.createElement(
      LoginAuthContext.Provider,
      { value: value as React.ContextType<typeof LoginAuthContext> },
      React.createElement(LoginOAuthCallback, props),
    ),
  );
}

describe("<LoginOAuthCallback /> initial render", () => {
  test("renders the generic loading shell when no provider is given", () => {
    const html = render(ctx());
    expect(html).toContain("stwd-callback__loading");
    expect(html).toContain("Completing");
    expect(html).toContain("sign-in");
  });

  test("includes the provider name in the loading copy when provided", () => {
    const html = render(ctx(), { provider: "google" });
    expect(html).toContain("Completing");
    expect(html).toContain("google");
  });

  test("mounting does not throw when already authenticated", () => {
    expect(() => render(ctx({ isAuthenticated: true }))).not.toThrow();
  });

  test("hook order is stable across auth-context shapes (rules-of-hooks)", () => {
    expect(() =>
      render(ctx({ isAuthenticated: false, user: null })),
    ).not.toThrow();
    expect(() =>
      render(
        ctx({ isAuthenticated: true, user: { id: "u", email: "u@x.io" } }),
      ),
    ).not.toThrow();
  });
});
