/**
 * Selector parsing tests for browser workspace element targeting.
 */

import { describe, expect, it } from "vitest";
import {
  normalizeBrowserWorkspaceSelectorSyntax,
  parseBrowserWorkspaceSemanticSelector,
  trimBrowserWorkspaceQuotedValue,
} from "./browser-workspace-elements.js";

/**
 * The semantic selector parser turns an LLM-/user-authored selector string
 * (e.g. `role=button[name="Submit"]`, `text=Hello`, `label: Email`) into a
 * structured find command. It must strip quotes / has-text() wrappers, accept
 * both `:` and `=` separators, route each kind to the right findBy, and return
 * null for unknown kinds or selectors with no value (so a bad selector fails
 * cleanly instead of silently matching the wrong element).
 */

describe("trimBrowserWorkspaceQuotedValue", () => {
  it("unwraps single/double quotes and has-text()", () => {
    expect(trimBrowserWorkspaceQuotedValue('"Hello"')).toBe("Hello");
    expect(trimBrowserWorkspaceQuotedValue("'Hi'")).toBe("Hi");
    expect(trimBrowserWorkspaceQuotedValue('has-text("Sign in")')).toBe(
      "Sign in",
    );
    expect(trimBrowserWorkspaceQuotedValue("plain")).toBe("plain");
  });
});

describe("parseBrowserWorkspaceSemanticSelector", () => {
  it("routes each kind to the right findBy", () => {
    expect(parseBrowserWorkspaceSemanticSelector("css=.foo")).toEqual({
      selector: ".foo",
    });
    expect(parseBrowserWorkspaceSemanticSelector("text=Hello")).toEqual({
      findBy: "text",
      text: "Hello",
    });
    expect(parseBrowserWorkspaceSemanticSelector("label: 'Email'")).toEqual({
      findBy: "label",
      text: "Email",
    });
    expect(parseBrowserWorkspaceSemanticSelector("testid=submit")).toEqual({
      findBy: "testid",
      text: "submit",
    });
  });

  it("parses role with an optional [name=...]", () => {
    expect(
      parseBrowserWorkspaceSemanticSelector('role=button[name="Submit"]'),
    ).toEqual({
      findBy: "role",
      role: "button",
      name: "Submit",
    });
    expect(parseBrowserWorkspaceSemanticSelector("role=link")).toEqual({
      findBy: "role",
      role: "link",
      name: undefined,
    });
  });

  it("returns null for unknown kinds or value-less selectors", () => {
    expect(parseBrowserWorkspaceSemanticSelector("bogus=x")).toBeNull();
    expect(
      parseBrowserWorkspaceSemanticSelector("no separator here"),
    ).toBeNull();
  });
});

describe("normalizeBrowserWorkspaceSelectorSyntax", () => {
  it("rewrites `role: x name: y` into role=x[name=y]", () => {
    const normalized = normalizeBrowserWorkspaceSelectorSyntax(
      "role: button name: Save",
    );
    expect(normalized).toBe("role=button[name=Save]");
    expect(
      parseBrowserWorkspaceSemanticSelector("role: button name: Save"),
    ).toMatchObject({
      findBy: "role",
      role: "button",
      name: "Save",
    });
  });
});
