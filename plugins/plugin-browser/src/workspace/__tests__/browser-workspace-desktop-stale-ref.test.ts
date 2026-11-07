/**
 * A desktop snapshot ref names an element of the page it was taken on. When
 * a click or submit navigated, the same selector would pick a control of the
 * new page; the ref is refused until the model snapshots again.
 */
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { createDesktopBrowserWorkspaceCommandScript } from "../browser-workspace-desktop.js";
import { resolveBrowserWorkspaceCommandElementRefs } from "../browser-workspace-helpers.js";
import {
  clearBrowserWorkspaceElementRefs,
  registerBrowserWorkspaceElementRefs,
} from "../browser-workspace-state.js";
import type { BrowserWorkspaceCommand } from "../browser-workspace-types.js";

function checkoutPage(): JSDOM {
  return new JSDOM(
    '<!doctype html><html><body><button type="submit">Pay now</button></body></html>',
    { url: "https://shop.test/checkout", runScripts: "outside-only" },
  );
}

function run(dom: JSDOM, command: BrowserWorkspaceCommand): unknown {
  return dom.window.eval(createDesktopBrowserWorkspaceCommandScript(command));
}

describe("desktop snapshot refs after navigation", () => {
  it("attaches the snapshot page to a resolved ref", () => {
    registerBrowserWorkspaceElementRefs(
      "desktop",
      "tab-1",
      [
        {
          selector: 'button[type="submit"]',
          tag: "button",
          text: "Save for later",
        } as never,
      ],
      "https://shop.test/cart",
    );
    try {
      expect(
        resolveBrowserWorkspaceCommandElementRefs(
          { subaction: "click", selector: "@e1" },
          "desktop",
          "tab-1",
        ),
      ).toEqual({
        subaction: "click",
        selector: 'button[type="submit"]',
        refUrl: "https://shop.test/cart",
      });
    } finally {
      clearBrowserWorkspaceElementRefs("desktop", "tab-1");
    }
  });

  it("refuses a ref from the cart page once the tab is on the checkout page", () => {
    const dom = checkoutPage();
    let clicked = 0;
    dom.window.document
      .querySelector("button")
      ?.addEventListener("click", () => {
        clicked += 1;
      });
    expect(() =>
      run(dom, {
        subaction: "click",
        selector: 'button[type="submit"]',
        refUrl: "https://shop.test/cart",
      }),
    ).toThrow(/Unknown browser snapshot element ref/);
    expect(clicked).toBe(0);
  });

  it("clicks a ref taken on the current page", () => {
    const dom = checkoutPage();
    let clicked = 0;
    dom.window.document
      .querySelector("button")
      ?.addEventListener("click", () => {
        clicked += 1;
      });
    const result = run(dom, {
      subaction: "click",
      selector: 'button[type="submit"]',
      refUrl: "https://shop.test/checkout",
    }) as { clickCount?: number };
    expect({ clicked, clickCount: result.clickCount }).toEqual({
      clicked: 1,
      clickCount: 1,
    });
  });
});
