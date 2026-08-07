/**
 * Guards malformed model-emitted UiSpec values in jsdom and Testing Library.
 * Invalid elements remain contained within the widget instead of reaching the
 * app-root error screen when conversation history rehydrates them.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSpec } from "../../config/ui-spec";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";
import { MessageUiSpecBlock } from "./MessageContent";

function withApp(node: React.ReactElement) {
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    sendActionMessage: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  return render(
    React.createElement(AppContext.Provider, { value: appValue }, node),
  );
}

const asSpec = (o: unknown) => o as unknown as UiSpec;

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
});

describe("MessageUiSpecBlock — a malformed model spec never bricks the app", () => {
  it("renders an element that omits props and children without throwing", () => {
    // LLMs routinely emit leaf elements with no `props`/`children`. Pre-fix
    // this threw Object.entries(undefined) / undefined.map() out of render.
    const spec = asSpec({ root: "a", elements: { a: { type: "Text" } } });
    expect(() =>
      withApp(
        React.createElement(MessageUiSpecBlock, {
          spec,
          raw: JSON.stringify(spec),
        }),
      ),
    ).not.toThrow();
  });

  it("contains a renderer crash (non-array array-prop) to the widget fallback instead of propagating to the app root", () => {
    // A Table whose `rows`/`columns` are strings, not arrays: the `?? []` cast
    // doesn't guard wrong types, so `.map` throws. The ErrorBoundary must catch
    // it and render the fallback rather than letting it escape render().
    const spec = asSpec({
      root: "a",
      elements: {
        a: { type: "Table", props: { rows: "nope", columns: "nope" } },
      },
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    let container: HTMLElement | undefined;
    expect(() => {
      container = withApp(
        React.createElement(MessageUiSpecBlock, {
          spec,
          raw: JSON.stringify(spec),
        }),
      ).container;
    }).not.toThrow();
    // The whole message did not disappear behind a root error screen — the
    // contained fallback is shown, and the raw JSON stays reachable.
    expect(screen.getByText("Couldn't render this widget.")).toBeTruthy();
    expect(container?.textContent ?? "").toContain("View JSON");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
