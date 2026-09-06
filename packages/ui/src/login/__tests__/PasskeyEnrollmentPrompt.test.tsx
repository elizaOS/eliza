/**
 * <PasskeyEnrollmentPrompt /> initial-render coverage.
 *
 * The prompt's visibility is decided inside a `useEffect` that reads
 * `window.sessionStorage`. SSR does not flush effects (and there is no DOM),
 * so `visible` stays false and the component renders nothing on first render
 * for every context shape. We assert that null-render contract and the
 * rules-of-hooks invariant (the component reads ctx + runs three useState +
 * one useEffect unconditionally before the early return). The enroll /
 * dismiss interaction is effect + DOM driven and lives in the browser e2e
 * suite.
 */

import * as React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";

const { PasskeyEnrollmentPrompt } = await import(
  "../components/PasskeyEnrollmentPrompt.js"
);
const { LoginAuthContext } = await import("../provider.js");

function ctx(overrides: Record<string, unknown> = {}): any {
  return {
    isAuthenticated: false,
    isLoading: false,
    user: null,
    session: null,
    addPasskey: async () => ({}),
    ...overrides,
  };
}

function render(value: unknown, props: Record<string, unknown> = {}) {
  return renderToString(
    React.createElement(
      LoginAuthContext.Provider,
      { value: value as React.ContextType<typeof LoginAuthContext> },
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
