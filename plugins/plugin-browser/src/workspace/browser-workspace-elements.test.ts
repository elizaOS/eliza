/**
 * A page-controlled element id must not break the label and role lookup that
 * reads it: ids containing a quote are legal HTML, and the selector built from
 * them must still be valid.
 */
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  buildBrowserWorkspaceElementSelector,
  escapeBrowserWorkspaceCssIdentifier,
  findAllBrowserWorkspaceElementsByRole,
  getBrowserWorkspaceElementSearchTexts,
  resolveBrowserWorkspaceElement,
  resolveBrowserWorkspaceFindElement,
} from "./browser-workspace-elements.js";

function documentFrom(html: string): Document {
  return new JSDOM(html).window.document;
}

describe("browser workspace element search text", () => {
  it("reads the label of an element whose id contains a quote", () => {
    const document = documentFrom(
      `<label for='phone"work'>Work phone</label><input id='phone"work' aria-label="Phone">`,
    );
    const input = document.querySelector("input") as HTMLInputElement;

    expect(getBrowserWorkspaceElementSearchTexts(input)).toContain(
      "Work phone",
    );
  });

  it("finds a role and name while another match has a quoted id", () => {
    const document = documentFrom(
      `<button id='say"hi' aria-label="Other">Other</button>
       <button aria-label="Submit">Submit</button>`,
    );

    const found = findAllBrowserWorkspaceElementsByRole(
      document,
      "button",
      "Submit",
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.textContent).toBe("Submit");
  });
});

describe("browser workspace element selectors", () => {
  /** Every selector built for an element must match that element alone. */
  function expectUniqueSelectors(document: Document, query: string): string[] {
    return Array.from(document.querySelectorAll(query), (element) => {
      const selector = buildBrowserWorkspaceElementSelector(element);
      const matches = document.querySelectorAll(selector);
      expect(matches, selector).toHaveLength(1);
      expect(matches[0], selector).toBe(element);
      return selector;
    });
  }

  it("tells apart same-position siblings in separate parents", () => {
    const document = documentFrom(
      `<div><p><button>One</button></p></div><div><p><button>Two</button></p></div>`,
    );
    expect(new Set(expectUniqueSelectors(document, "button")).size).toBe(2);
  });

  it("tells apart the same field name in two forms", () => {
    const document = documentFrom(
      `<form><input name="q"></form><form id="second"><input name="q"></form>`,
    );
    expect(expectUniqueSelectors(document, "input")).toEqual([
      "form:nth-of-type(1) > input:nth-of-type(1)",
      "#second > input:nth-of-type(1)",
    ]);
  });

  it("tells apart the radios of a group", () => {
    const document = documentFrom(
      `<input type="radio" name="size" value="s"><input type="radio" name="size" value="m"><input type="radio" name="size" value="l">`,
    );
    expectUniqueSelectors(document, "input");
  });

  it("escapes an id that starts with a digit", () => {
    const document = documentFrom(`<input id="1-email"><input id="a:b">`);
    expect(escapeBrowserWorkspaceCssIdentifier("1-email")).toBe("\\31 -email");
    expect(escapeBrowserWorkspaceCssIdentifier("-1x")).toBe("-\\31 x");
    expect(escapeBrowserWorkspaceCssIdentifier("-")).toBe("\\-");
    expect(expectUniqueSelectors(document, "input")).toEqual([
      "#\\31 -email",
      "#a\\:b",
    ]);
  });

  it("queries a css: selector as CSS even when the command names a findBy", () => {
    const document = documentFrom(
      `<button>Plain</button><button class="primary">Go</button>`,
    );
    const found = resolveBrowserWorkspaceElement(
      document,
      "css:button.primary",
      undefined,
      { subaction: "click", findBy: "text", text: "Plain" },
    );
    expect(found?.textContent).toBe("Go");
  });

  it("honors exact for a text find", () => {
    const document = documentFrom(
      `<button>Buy later</button><button>Buy</button>`,
    );
    const find = (exact: boolean) =>
      resolveBrowserWorkspaceFindElement(document, {
        subaction: "find",
        findBy: "text",
        text: "Buy",
        exact,
      })?.textContent;
    expect(find(false)).toBe("Buy later");
    expect(find(true)).toBe("Buy");
  });
});
