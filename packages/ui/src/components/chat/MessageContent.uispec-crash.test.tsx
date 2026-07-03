// @vitest-environment jsdom
//
// Regression for the HIGH-severity demo-killer: a model-emitted UiSpec that is
// malformed in a way the renderer can't fully normalize (element missing
// `props`/`children`, or an array prop that isn't an array) used to throw out
// of MessageUiSpecBlock — past every view boundary to the app ROOT error
// screen. Because the offending message re-hydrates from conversation history,
// "Try Again" and full restarts re-crashed it, bricking the app until the
// conversation was cleared. The fix defaults missing props/children in
// ElementRenderer and wraps the UiRenderer in an ErrorBoundary, so any residual
// render throw is contained to the single widget with a "View JSON" fallback.

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
  });
});
