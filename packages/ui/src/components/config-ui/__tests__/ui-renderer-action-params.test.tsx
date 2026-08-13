/**
 * Regression for #18975: UiRenderer must resolve $path / $data dynamic
 * references in action params from live state at dispatch time — the same
 * resolution applied to element props. Without this, forms that declare
 * { field: { $path: "form.field" } } in their save action send the literal
 * { $path } object instead of the typed value.
 */
// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSpec } from "../../../config/ui-spec";
import { __setAppValueForTests } from "../../../state/app-store";
import { AppContext } from "../../../state/useApp";
import { UiRenderer } from "../ui-renderer";

function renderSpec(spec: unknown) {
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    sendActionMessage: () => {},
  } as never;
  __setAppValueForTests(appValue);
  return render(
    <AppContext.Provider value={appValue}>
      <UiRenderer spec={spec as UiSpec} />
    </AppContext.Provider>,
  ).container;
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
});

describe("UiRenderer resolves $path references in action params", () => {
  it("resolves $path action params from state when a button is pressed", () => {
    const onAction = vi.fn();

    const spec: UiSpec = {
      root: "root",
      elements: {
        root: {
          type: "Card",
          props: {},
          children: ["email-input", "submit-btn"],
        },
        "email-input": {
          type: "Input",
          props: {
            label: "Email",
            statePath: "form.email",
          },
          children: [],
        },
        "submit-btn": {
          type: "Button",
          props: {
            text: "Submit",
            variant: "primary",
          },
          children: [],
          on: {
            press: {
              action: "saveForm",
              params: {
                email: { $path: "form.email" },
              },
            },
          },
        },
      },
      state: {
        form: { email: "" },
      },
    };

    const { container } = render(
      <AppContext.Provider
        value={
          {
            t: (key: string) => key,
            sendActionMessage: () => {},
            onAction,
          } as never
        }
      >
        <UiRenderer spec={spec} onAction={onAction} />
      </AppContext.Provider>,
    );

    // Type a value into the email field
    const input = container.querySelector('input[name=""]') as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "test@example.com" } });

    // Click submit — the action params should resolve $path: "form.email"
    // to the live state value "test@example.com", not pass the raw { $path }
    // object.
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button).toBeTruthy();
    fireEvent.click(button);

    expect(onAction).toHaveBeenCalledTimes(1);
    const [action, params] = onAction.mock.calls[0];
    expect(action).toBe("saveForm");
    expect(params).toEqual({ email: "test@example.com" });
    // The raw $path object must NOT leak through
    expect(params).not.toEqual({ email: { $path: "form.email" } });
  });
});
