/**
 * Snapshot element refs must name one control. Two text inputs, or two
 * buttons in different parents, used to share one selector, so the second
 * ref filled or clicked the first control.
 */
import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
  openBrowserWorkspaceTab,
} from "../browser-workspace.js";
import { createDesktopBrowserWorkspaceCommandScript } from "../browser-workspace-desktop.js";

const webEnv: NodeJS.ProcessEnv = {};

const twinInputsHtml = `<!doctype html><html><body>
<label>First <input type="text" /></label>
<label>Last <input type="text" /></label>
</body></html>`;

afterEach(() => __resetBrowserWorkspaceStateForTests());

it("fills the second identical text input through its snapshot ref", async () => {
  const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, webEnv);
  const url = "https://example.test/twins";
  await executeBrowserWorkspaceCommand(
    {
      id: tab.id,
      subaction: "network",
      networkAction: "route",
      url,
      responseBody: twinInputsHtml,
    },
    webEnv,
  );
  await executeBrowserWorkspaceCommand(
    { id: tab.id, subaction: "navigate", url },
    webEnv,
  );
  const snapshot = await executeBrowserWorkspaceCommand(
    { id: tab.id, subaction: "snapshot" },
    webEnv,
  );
  const inputs = (snapshot.elements ?? []).filter(
    (element) => element.tag === "input",
  );
  expect(inputs).toHaveLength(2);
  expect(new Set(inputs.map((element) => element.selector)).size).toBe(2);
  const second = inputs[1];
  expect(second?.ref).toMatch(/^@e\d+$/);
  await executeBrowserWorkspaceCommand(
    {
      id: tab.id,
      subaction: "fill",
      selector: second?.ref,
      value: "last-name",
    },
    webEnv,
  );
  const secondValue = await executeBrowserWorkspaceCommand(
    {
      id: tab.id,
      subaction: "get",
      getMode: "value",
      selector: second?.selector,
    },
    webEnv,
  );
  const firstValue = await executeBrowserWorkspaceCommand(
    {
      id: tab.id,
      subaction: "get",
      getMode: "value",
      selector: inputs[0]?.selector,
    },
    webEnv,
  );
  expect(secondValue.value).toBe("last-name");
  expect(firstValue.value).toBe("");
});

it("points a desktop inspect selector at the second sibling button", () => {
  const html = `<div><button type="button">Save</button></div><div><button type="button">Delete</button></div>`;
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  try {
    const inspected = dom.window.eval(
      createDesktopBrowserWorkspaceCommandScript({ subaction: "inspect" }),
    ) as { elements: Array<{ tag: string; selector: string }> };
    const buttons = inspected.elements.filter(
      (element) => element.tag === "button",
    );
    expect(buttons).toHaveLength(2);
    const second = dom.window.document.querySelector(
      buttons[1]?.selector ?? "",
    );
    expect(second).toBe(dom.window.document.querySelectorAll("button")[1]);
    expect(second?.textContent).toBe("Delete");
  } finally {
    dom.window.close();
  }
});
