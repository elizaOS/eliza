/** Exercises loading, signed-out and signed-in rendering through the public UI root using the real auth context. */
import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

const { LoginAuthGuard } = await import("../../index.ts");
const { LoginAuthContext } = await import("../provider.js");

function ctx(overrides: Record<string, unknown>): any {
  return {
    isAuthenticated: false,
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
    ...overrides,
  };
}

function wrap(value: unknown, node: React.ReactNode) {
  return React.createElement(
    LoginAuthContext.Provider,
    { value: value as React.ContextType<typeof LoginAuthContext> },
    node,
  );
}

const child = React.createElement(
  "div",
  { "data-testid": "protected" },
  "secret",
);

describe("LoginAuthGuard public root rendering", () => {
  test("loading branch renders the default spinner", () => {
    const html = renderToString(
      wrap(ctx({ isLoading: true }), <LoginAuthGuard>{child}</LoginAuthGuard>),
    );
    expect(html).toContain("stwd-auth-guard__loading");
    expect(html).toContain("Loading");
    expect(html).not.toContain("secret");
  });

  test("loading branch renders a custom loadingFallback when provided", () => {
    const html = renderToString(
      wrap(
        ctx({ isLoading: true }),
        <LoginAuthGuard loadingFallback={<p>please wait</p>}>
          {child}
        </LoginAuthGuard>,
      ),
    );
    expect(html).toContain("please wait");
    expect(html).not.toContain("Loading…");
  });

  test("unauthenticated branch renders a custom fallback", () => {
    const html = renderToString(
      wrap(
        ctx({ isAuthenticated: false, isLoading: false }),
        <LoginAuthGuard fallback={<p>log in please</p>}>
          {child}
        </LoginAuthGuard>,
      ),
    );
    expect(html).toContain("stwd-auth-guard");
    expect(html).toContain("log in please");
    expect(html).not.toContain("secret");
  });

  test("authenticated branch renders the children", () => {
    const html = renderToString(
      wrap(
        ctx({ isAuthenticated: true, isLoading: false }),
        <LoginAuthGuard>{child}</LoginAuthGuard>,
      ),
    );
    expect(html).toContain("secret");
    expect(html).not.toContain("stwd-auth-guard__loading");
  });
});
