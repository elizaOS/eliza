/**
 * Desktop utility script frame selection, run in a real JSDOM page, and the
 * desktop bridge eval transport against a real local HTTP bridge.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  createDesktopBrowserWorkspaceUtilityScript,
  executeDesktopBrowserWorkspaceDomCommand,
} from "../browser-workspace-desktop.js";
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

describe("desktop browser workspace bridge eval", () => {
  it("waits for a page wait longer than the 12s bridge default", async () => {
    // The desktop host runs page scripts for up to 30s; this bridge answers
    // the eval after 13s, as a wait whose element appears late does.
    const server = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: { selector: "#dashboard" } }));
      }, 13_000);
      req.resume();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const result = await executeDesktopBrowserWorkspaceDomCommand(
        {
          subaction: "wait",
          id: "tab-1",
          selector: "#dashboard",
          timeoutMs: 20_000,
        },
        { ELIZA_BROWSER_WORKSPACE_URL: `http://127.0.0.1:${port}` },
      );
      expect(result.mode).toBe("desktop");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
