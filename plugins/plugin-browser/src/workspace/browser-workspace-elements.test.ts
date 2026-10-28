/**
 * A page-controlled element id must not break the label and role lookup that
 * reads it: ids containing a quote are legal HTML, and the selector built from
 * them must still be valid.
 */
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  findAllBrowserWorkspaceElementsByRole,
  getBrowserWorkspaceElementSearchTexts,
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
