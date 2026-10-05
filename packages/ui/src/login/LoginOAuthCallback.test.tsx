import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { createLoginAuthContext as ctx } from "../../test/login-auth-context.js";

const { LoginOAuthCallback } = await import("./LoginOAuthCallback.js");
const { LoginAuthContext } = await import("./provider.js");

function render(
  value: ReturnType<typeof ctx>,
  props: Record<string, unknown> = {},
) {
  return renderToString(
    React.createElement(
      LoginAuthContext.Provider,
      { value: value },
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
