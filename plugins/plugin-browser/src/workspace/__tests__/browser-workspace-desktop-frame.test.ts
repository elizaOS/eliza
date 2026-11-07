/**
 * Desktop utility script frame selection, run in a real JSDOM page, and the
 * desktop bridge eval transport against a real local HTTP bridge.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  createDesktopBrowserWorkspaceCommandScript,
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

describe("desktop browser workspace DOM commands after frame select", () => {
  function runCommand(dom: JSDOM, command: BrowserWorkspaceCommand): unknown {
    return dom.window.eval(createDesktopBrowserWorkspaceCommandScript(command));
  }

  it("clicks the selected frame's element, not the top document's", () => {
    const dom = openPage(
      '<button id="target">Main</button><iframe id="second-frame"></iframe>',
    );
    const clicked: string[] = [];
    dom.window.document
      .querySelector("#target")
      ?.addEventListener("click", () => clicked.push("main"));
    dom.window.document
      .querySelector<HTMLIFrameElement>("#second-frame")
      ?.contentDocument?.querySelector("#target")
      ?.addEventListener("click", () => clicked.push("frame"));

    run(dom, { subaction: "frame", selector: "#second-frame" });
    const result = runCommand(dom, { subaction: "click", selector: "#target" });

    expect(result).toMatchObject({ element: { selector: "#target" } });
    expect(clicked).toEqual(["frame"]);
  });

  it("fills, checks and selects form controls inside the selected frame", () => {
    const dom = openPage(
      '<input id="email" value="main"><iframe id="second-frame"></iframe>',
    );
    const frameDocument =
      dom.window.document.querySelector<HTMLIFrameElement>(
        "#second-frame",
      )?.contentDocument;
    if (!frameDocument) throw new Error("iframe has no document");
    frameDocument.body.innerHTML =
      '<input id="email"><input id="agree" type="checkbox">' +
      '<select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>';
    const inputEvents: string[] = [];
    frameDocument
      .querySelector("#email")
      ?.addEventListener("input", () => inputEvents.push("frame-email"));

    run(dom, { subaction: "frame", selector: "#second-frame" });
    runCommand(dom, {
      subaction: "fill",
      selector: "#email",
      value: "a@b.test",
    });
    runCommand(dom, { subaction: "check", selector: "#agree" });
    runCommand(dom, { subaction: "select", selector: "#plan", value: "pro" });

    expect(frameDocument.querySelector<HTMLInputElement>("#email")?.value).toBe(
      "a@b.test",
    );
    expect(inputEvents).toEqual(["frame-email"]);
    expect(
      frameDocument.querySelector<HTMLInputElement>("#agree")?.checked,
    ).toBe(true);
    expect(frameDocument.querySelector<HTMLSelectElement>("#plan")?.value).toBe(
      "pro",
    );
    expect(
      dom.window.document.querySelector<HTMLInputElement>("#email")?.value,
    ).toBe("main");
    expect(
      runCommand(dom, {
        subaction: "get",
        getMode: "value",
        selector: "#email",
      }),
    ).toEqual({ value: "a@b.test" });
  });

  it("snapshots the selected frame's elements and text", () => {
    const dom = openPage(
      '<button id="main-only">Main</button><iframe id="second-frame"></iframe>',
    );
    run(dom, { subaction: "frame", selector: "#second-frame" });

    const snapshot = runCommand(dom, { subaction: "snapshot" }) as {
      bodyText?: string;
      elements?: Array<{ selector: string }>;
    };

    expect(snapshot.bodyText).toBe("Go");
    expect(snapshot.elements?.map((element) => element.selector)).toContain(
      "#target",
    );
    expect(snapshot.elements?.map((element) => element.selector)).not.toContain(
      "#main-only",
    );
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
