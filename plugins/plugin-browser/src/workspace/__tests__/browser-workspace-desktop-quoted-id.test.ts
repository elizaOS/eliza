/**
 * Page ids and test ids that contain a quote are legal HTML. The desktop page
 * script must still build valid selectors from them, so a role lookup that
 * reads labels and a test-id lookup do not throw.
 */
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { createDesktopBrowserWorkspaceCommandScript } from "../browser-workspace-desktop.js";
import type { BrowserWorkspaceCommand } from "../browser-workspace-types.js";

function run(body: string, command: BrowserWorkspaceCommand): unknown {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    runScripts: "outside-only",
  });
  return dom.window.eval(createDesktopBrowserWorkspaceCommandScript(command));
}

describe("desktop browser workspace lookup with a quoted id", () => {
  it("reads the label of an element whose id contains a quote", () => {
    const result = run(
      `<label for='phone"work'>Work phone</label><input id='phone"work' value="555">`,
      {
        subaction: "find",
        findBy: "role",
        role: "textbox",
        name: "Work phone",
      },
    ) as { element: { value: string | null } };

    expect(result.element.value).toBe("555");
  });

  it("finds a role and name while another match has a quoted id", () => {
    const result = run(
      `<button id='say"hi'>Other</button><button>Submit</button>`,
      { subaction: "find", findBy: "role", role: "button", name: "Submit" },
    ) as { value: string };

    expect(result.value).toBe("Submit");
  });

  it("finds an element by a test id that contains a quote", () => {
    const result = run(`<button data-testid='save"draft'>Save</button>`, {
      subaction: "find",
      findBy: "testid",
      text: 'save"draft',
    }) as { value: string };

    expect(result.value).toBe("Save");
  });
});
