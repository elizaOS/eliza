/**
 * <LoginEmailCallback /> initial-render coverage.
 *
 * The component's verification logic lives entirely in a `useEffect` that
 * reads `window.location.search` and calls `verifyEmailCallback`. The test
 * runner has no DOM and SSR does not flush effects, so we cover the
 * deterministic initial render (step === "loading") plus the rules-of-hooks
 * invariant across auth-context shapes. The success / error / retry branches
 * are effect + DOM driven and are exercised by the browser e2e suite.
 */

import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

const { LoginEmailCallback } = await import(
  "../components/LoginEmailCallback.js"
);
const { LoginAuthContext } = await import("../provider.js");

function ctx(overrides: Record<string, unknown> = {}): any {
  return {
    isAuthenticated: false,
    isLoading: false,
    user: null,
    session: null,
    verifyEmailCallback: async () => ({}),
    ...overrides,
  };
}

function render(value: unknown, props: Record<string, unknown> = {}) {
  return renderToString(
    React.createElement(
      LoginAuthContext.Provider,
      { value: value as React.ContextType<typeof LoginAuthContext> },
      React.createElement(LoginEmailCallback, props),
    ),
  );
}

describe("<LoginEmailCallback /> initial render", () => {
  test("renders the loading shell on first render", () => {
    const html = render(ctx());
    expect(html).toContain("stwd-callback__loading");
    expect(html).toContain("Verifying your sign-in link");
  });

  test("loading shell renders regardless of redirectTo prop", () => {
    const html = render(ctx(), { redirectTo: "/dashboard" });
    expect(html).toContain("stwd-callback__loading");
  });

  test("mounting does not throw when already authenticated", () => {
    // The effect handles the already-authenticated short-circuit, but the
    // initial render is still the loading shell (effect has not run under SSR).
    expect(() => render(ctx({ isAuthenticated: true }))).not.toThrow();
  });

  test("hook order is stable across auth-context shapes (rules-of-hooks)", () => {
    expect(() => render(ctx({ isAuthenticated: false }))).not.toThrow();
    expect(() => render(ctx({ isAuthenticated: true }))).not.toThrow();
  });
});
