import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { createLoginAuthContext as ctx } from "../../test/login-auth-context.js";

import { LoginAuthGuard } from "../index.ts";
import { LoginAuthContext } from "./provider.js";

function wrap(value: ReturnType<typeof ctx>, node: React.ReactNode) {
  return React.createElement(LoginAuthContext.Provider, { value: value }, node);
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
