/** Verifies that generated icon-only controls expose accessible names. */
// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

describe("UiRenderer icon-control accessibility", () => {
  it("names dialog, pagination, and carousel controls", () => {
    const dialog = renderSpec({
      root: "a",
      elements: {
        a: {
          type: "Dialog",
          props: { openPath: "open", title: "Hi" },
          children: [],
        },
      },
      state: { open: true },
    });
    expect(
      dialog.querySelector('button[aria-label="Close dialog"]'),
    ).toBeTruthy();

    const pager = renderSpec({
      root: "a",
      elements: {
        a: { type: "Pagination", props: { statePath: "p", totalPages: 3 } },
      },
    });
    expect(
      pager.querySelector('button[aria-label="Previous page"]'),
    ).toBeTruthy();
    expect(pager.querySelector('button[aria-label="Next page"]')).toBeTruthy();

    const carousel = renderSpec({
      root: "a",
      elements: {
        a: {
          type: "Carousel",
          props: {
            items: [
              { title: "One", description: "first" },
              { title: "Two", description: "second" },
            ],
          },
        },
      },
    });
    expect(
      carousel.querySelector('button[aria-label="Previous item"]'),
    ).toBeTruthy();
    expect(
      carousel.querySelector('button[aria-label="Next item"]'),
    ).toBeTruthy();
  });
});
