// @vitest-environment jsdom
//
// Tap-target floor guard for the agent-emitted UiRenderer control family
// (#14399 device review: "buttons too small on the demo buttons view").
//
// These controls render inside chat / widget / dynamic-view surfaces, not at a
// standalone `/route`, so the route-walking `tap-target-geometry-all-views`
// Playwright gate never measured them. Pre-fix the whole button family shipped
// at ~28-30px tall (`px-3 py-1.5 text-xs`), under the 44px HIG floor on a touch
// device. The fix composes the shared coarse-pointer floor
// (`pointer-coarse:min-h-touch` / `pointer-coarse:min-w-touch`, resolving to
// `var(--min-touch-target)` = 2.75rem) onto every tappable control so touch
// hits the floor while fine-pointer keeps the compact resting look.
//
// jsdom does not run layout, so this asserts the class CONTRACT that produces
// the floor (the same convention chat-composer.tsx uses) rather than measured
// geometry — geometry stays the Playwright gate's job. Every button-family
// control here must carry at least the coarse-pointer height floor; standalone
// (non-full-width) controls must also carry the width floor.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiSpec } from "../../../config/ui-spec";
import { __setAppValueForTests } from "../../../state/app-store";
import { AppContext } from "../../../state/useApp";
import { UiRenderer } from "../ui-renderer";

function withApp(node: React.ReactElement) {
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    sendActionMessage: () => {},
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

const HEIGHT_FLOOR = "pointer-coarse:min-h-touch";
const WIDTH_FLOOR = "pointer-coarse:min-w-touch";

function renderSpec(spec: unknown) {
  return withApp(React.createElement(UiRenderer, { spec: asSpec(spec) }))
    .container;
}

describe("UiRenderer tap-target floor — standalone button-family controls", () => {
  // Each case: a spec whose root renders exactly one control family; every
  // <button> it produces must carry both the height AND width coarse-pointer
  // floor (these are freestanding controls, not full-width rows).
  const standaloneCases: Array<{ name: string; spec: unknown }> = [
    {
      name: "Button",
      spec: {
        root: "a",
        elements: { a: { type: "Button", props: { label: "Go" } } },
      },
    },
    {
      name: "ButtonGroup",
      spec: {
        root: "a",
        elements: {
          a: {
            type: "ButtonGroup",
            props: {
              statePath: "v",
              buttons: [
                { label: "One", value: "1" },
                { label: "Two", value: "2" },
              ],
            },
          },
        },
      },
    },
    {
      name: "ToggleGroup",
      spec: {
        root: "a",
        elements: {
          a: {
            type: "ToggleGroup",
            props: {
              statePath: "v",
              items: [
                { label: "A", value: "a" },
                { label: "B", value: "b" },
              ],
            },
          },
        },
      },
    },
    {
      name: "Toggle",
      spec: {
        root: "a",
        elements: {
          a: { type: "Toggle", props: { statePath: "v", label: "Flag" } },
        },
      },
    },
    {
      name: "Switch",
      spec: {
        root: "a",
        elements: {
          a: { type: "Switch", props: { statePath: "v", label: "On" } },
        },
      },
    },
    {
      name: "Tabs",
      spec: {
        root: "a",
        elements: {
          a: {
            type: "Tabs",
            props: {
              statePath: "v",
              tabs: [
                { label: "First", value: "1", content: "one" },
                { label: "Second", value: "2", content: "two" },
              ],
            },
          },
        },
      },
    },
    {
      name: "Pagination",
      spec: {
        root: "a",
        elements: {
          a: {
            type: "Pagination",
            props: { statePath: "p", totalPages: 3 },
          },
        },
      },
    },
    {
      name: "DropdownMenu trigger",
      spec: {
        root: "a",
        elements: {
          a: {
            type: "DropdownMenu",
            props: {
              label: "Menu",
              items: [{ label: "Item", value: "i" }],
            },
          },
        },
      },
    },
    {
      name: "Carousel nav",
      spec: {
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
      },
    },
  ];

  for (const { name, spec } of standaloneCases) {
    it(`${name}: every button carries the coarse-pointer height + width floor`, () => {
      const container = renderSpec(spec);
      const buttons = Array.from(container.querySelectorAll("button"));
      expect(buttons.length).toBeGreaterThan(0);
      for (const btn of buttons) {
        expect(btn.className).toContain(HEIGHT_FLOOR);
        expect(btn.className).toContain(WIDTH_FLOOR);
      }
    });
  }
});

describe("UiRenderer tap-target floor — full-width row controls (height floor only)", () => {
  // Collapsible / Accordion headers and DropdownMenu items are full-width rows,
  // so the width floor is already satisfied by the row; they only need the
  // coarse-pointer height floor to clear 44px.
  const rowCases: Array<{ name: string; spec: unknown }> = [
    {
      name: "Collapsible header",
      spec: {
        root: "a",
        elements: {
          a: {
            type: "Collapsible",
            props: { title: "More", defaultOpen: false },
          },
        },
      },
    },
    {
      name: "Accordion header",
      spec: {
        root: "a",
        elements: {
          a: {
            type: "Accordion",
            props: {
              items: [{ title: "Section", content: "body" }],
            },
          },
        },
      },
    },
  ];

  for (const { name, spec } of rowCases) {
    it(`${name}: header button carries the coarse-pointer height floor`, () => {
      const container = renderSpec(spec);
      const buttons = Array.from(container.querySelectorAll("button"));
      expect(buttons.length).toBeGreaterThan(0);
      for (const btn of buttons) {
        expect(btn.className).toContain(HEIGHT_FLOOR);
      }
    });
  }

  it("DropdownMenu items carry the coarse-pointer height floor when open", () => {
    const container = renderSpec({
      root: "a",
      elements: {
        a: {
          type: "DropdownMenu",
          props: {
            label: "Menu",
            items: [
              { label: "First", value: "1" },
              { label: "Second", value: "2" },
            ],
          },
        },
      },
    });
    const trigger = container.querySelector("button");
    expect(trigger).toBeTruthy();
    act(() => {
      fireEvent.click(trigger as HTMLButtonElement);
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    // trigger + 2 items
    expect(buttons.length).toBe(3);
    for (const btn of buttons) {
      expect(btn.className).toContain(HEIGHT_FLOOR);
    }
  });
});

describe("UiRenderer tap-target floor — accessible names on icon-only controls", () => {
  it("Dialog close, Pagination arrows, and Carousel arrows expose an accessible name", () => {
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
    const close = dialog.querySelector('button[aria-label="Close dialog"]');
    expect(close).toBeTruthy();

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
