import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { createLoginAuthContext as ctx } from "../../test/login-auth-context.js";

const { LoginEmailCallback } = await import("./LoginEmailCallback.js");
const { LoginAuthContext } = await import("./provider.js");

function render(
  value: ReturnType<typeof ctx>,
  props: Record<string, unknown> = {},
) {
  return renderToString(
    React.createElement(
      LoginAuthContext.Provider,
      { value: value },
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
