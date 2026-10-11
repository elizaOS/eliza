/**
 * Desktop utility script frame selection, run in a real JSDOM page.
 */

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { createDesktopBrowserWorkspaceUtilityScript } from "../browser-workspace-desktop.js";
import type { BrowserWorkspaceCommand } from "../browser-workspace-types.js";

function openPage(body: string): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    runScripts: "outside-only",
  });
  for (const frame of dom.window.document.querySelectorAll("iframe")) {
    const frameDocument = frame.contentDocument;
    if (!frameDocument) throw new Error("iframe has no document");
    frameDocument.body.innerHTML = '<button id="target">Go</button>';
  }
  return dom;
}

function run(dom: JSDOM, command: BrowserWorkspaceCommand): unknown {
  return dom.window.eval(createDesktopBrowserWorkspaceUtilityScript(command));
}

function highlightedFrames(dom: JSDOM): boolean[] {
  return Array.from(dom.window.document.querySelectorAll("iframe"), (frame) =>
    Boolean(
      frame.contentDocument
        ?.querySelector("#target")
        ?.hasAttribute("data-eliza-highlight"),
    ),
  );
}

describe("desktop browser workspace frame select", () => {
  it("runs later commands in the second iframe selected by id", () => {
    const dom = openPage(
      '<iframe id="first-frame"></iframe><iframe id="second-frame"></iframe>',
    );

    expect(run(dom, { subaction: "frame", selector: "#second-frame" })).toEqual(
      { frame: "#second-frame" },
    );
    run(dom, { subaction: "highlight", selector: "#target" });

    expect(highlightedFrames(dom)).toEqual([false, true]);
  });

  it("runs later commands in the selected id-less iframe of a second parent", () => {
    const dom = openPage(
      '<div class="embed"><iframe></iframe></div><div class="embed"><iframe></iframe></div>',
    );

    run(dom, {
      subaction: "frame",
      selector: ".embed:nth-of-type(2) > iframe",
    });
    run(dom, { subaction: "highlight", selector: "#target" });

    expect(highlightedFrames(dom)).toEqual([false, true]);
  });
});
