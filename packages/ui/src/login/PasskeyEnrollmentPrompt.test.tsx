import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { createLoginAuthContext as ctx } from "../../test/login-auth-context.js";

const { PasskeyEnrollmentPrompt } = await import(
  "./PasskeyEnrollmentPrompt.js"
);
const { LoginAuthContext } = await import("./provider.js");

function render(
  value: ReturnType<typeof ctx>,
  props: Record<string, unknown> = {},
) {
  return renderToString(
    React.createElement(
      LoginAuthContext.Provider,
      { value: value },
      React.createElement(PasskeyEnrollmentPrompt, props),
    ),
  );
}

describe("<PasskeyEnrollmentPrompt /> initial render", () => {
  test("renders nothing when unauthenticated", () => {
    expect(render(ctx({ isAuthenticated: false }))).toBe("");
  });

  test("renders nothing on first render even when authenticated (effect not flushed under SSR)", () => {
    // visibility is set by the sessionStorage-reading effect, which SSR skips.
    expect(
      render(
        ctx({ isAuthenticated: true, user: { id: "u", email: "u@x.io" } }),
      ),
    ).toBe("");
  });

  test("renders nothing with no auth context at all", () => {
    expect(
      renderToString(
        React.createElement(
          LoginAuthContext.Provider,
          { value: null },
          React.createElement(PasskeyEnrollmentPrompt, {}),
        ),
      ),
    ).toBe("");
  });

  test("does not throw across variant props and context shapes (rules-of-hooks)", () => {
    for (const variant of ["banner", "inline", "toast"] as const) {
      expect(() =>
        render(ctx({ isAuthenticated: false }), { variant }),
      ).not.toThrow();
      expect(() =>
        render(
          ctx({ isAuthenticated: true, user: { id: "u", email: "u@x.io" } }),
          {
            variant,
            alwaysShow: true,
          },
        ),
      ).not.toThrow();
    }
  });
});
