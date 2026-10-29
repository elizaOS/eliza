/**
 * Snapshot element refs (`@eN`) are stored as selectors and read back with
 * querySelector, which returns the first match. Each ref must address the
 * element the snapshot listed, in web mode and through the desktop bridge.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
  listBrowserWorkspaceTabs,
  openBrowserWorkspaceTab,
} from "../browser-workspace.js";
import { executeDesktopBrowserWorkspaceDomCommand } from "../browser-workspace-desktop.js";
import type { BrowserWorkspaceDomElementSummary } from "../browser-workspace-types.js";

const webEnv: NodeJS.ProcessEnv = {};

const accountHtml = `<!doctype html>
<html><head><title>Account</title></head><body>
  <form action="/delete" method="post">
    <button name="delete">Delete account</button>
  </form>
  <div class="toolbar"><button>Cancel</button></div>
  <div class="toolbar"><button>Save</button></div>
  <form action="/search" method="get">
    <input name="q" type="text" placeholder="Search" />
  </form>
  <div><input type="text" placeholder="Email" /></div>
</body></html>`;

function findElement(
  elements: BrowserWorkspaceDomElementSummary[] | undefined,
  predicate: (element: BrowserWorkspaceDomElementSummary) => boolean,
): BrowserWorkspaceDomElementSummary {
  const element = elements?.find(predicate);
  if (!element) throw new Error("snapshot did not list the element");
  return element;
}

async function openAccountPage() {
  const tab = await openBrowserWorkspaceTab(
    { show: true, url: "about:blank" },
    webEnv,
  );
  // Routes match by substring, newest first: register the root first.
  for (const [url, responseBody] of [
    ["https://shop.test/", accountHtml],
    [
      "https://shop.test/delete",
      "<title>Deleted</title><p>Account deleted</p>",
    ],
  ] as const) {
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "network",
        networkAction: "route",
        url,
        responseBody,
      },
      webEnv,
    );
  }
  await executeBrowserWorkspaceCommand(
    { id: tab.id, subaction: "navigate", url: "https://shop.test/" },
    webEnv,
  );
  return tab;
}

describe("web browser workspace snapshot element refs", () => {
  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
  });

  it("lists the unnamed button of each toolbar", async () => {
    const tab = await openAccountPage();
    const snapshot = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "snapshot" },
      webEnv,
    );

    expect(
      snapshot.elements
        ?.filter((element) => element.tag === "button")
        .map((element) => element.text),
    ).toEqual(["Delete account", "Cancel", "Save"]);
  });

  it("clicks the Cancel ref without submitting the Delete account form", async () => {
    const tab = await openAccountPage();
    const snapshot = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "snapshot" },
      webEnv,
    );
    const cancel = findElement(
      snapshot.elements,
      (element) => element.text === "Cancel",
    );

    const clicked = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "click", selector: cancel.ref },
      webEnv,
    );

    // Cancel sits outside every form, so clicking it must not submit /delete.
    expect(clicked.value).toMatchObject({ text: "Cancel" });
    const [current] = await listBrowserWorkspaceTabs(webEnv);
    expect(current?.url).toBe("https://shop.test/");
    expect(current?.title).toBe("Account");
  });

  it("fills the Email ref, not the search box listed before it", async () => {
    const tab = await openAccountPage();
    const snapshot = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "snapshot" },
      webEnv,
    );
    const email = findElement(
      snapshot.elements,
      (element) => element.tag === "input" && element.name === null,
    );

    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "fill",
        selector: email.ref,
        value: "owner@example.com",
      },
      webEnv,
    );

    const read = async (selector: string) =>
      (
        await executeBrowserWorkspaceCommand(
          { id: tab.id, subaction: "get", getMode: "value", selector },
          webEnv,
        )
      ).value;
    expect(await read('input[name="q"]')).toBe("");
    expect(await read('input[placeholder="Email"]')).toBe("owner@example.com");
  });
});

describe("desktop browser workspace snapshot element refs", () => {
  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
  });

  it("clicks the element the snapshot listed for each ref", async () => {
    // A local bridge that runs each page script in one real JSDOM page, as
    // the desktop host runs it in the tab.
    const dom = new JSDOM(accountHtml, {
      runScripts: "outside-only",
      url: "https://shop.test/",
    });
    const clicked: string[] = [];
    dom.window.document.addEventListener("click", (event) => {
      clicked.push(
        (event.target as Element).textContent?.trim() ??
          (event.target as Element).tagName,
      );
    });
    dom.window.document.addEventListener("submit", (event) => {
      event.preventDefault();
    });
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        const { script } = JSON.parse(body) as { script: string };
        const result = await dom.window.eval(script);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const env = { ELIZA_BROWSER_WORKSPACE_URL: `http://127.0.0.1:${port}` };
    try {
      const snapshot = await executeDesktopBrowserWorkspaceDomCommand(
        { subaction: "snapshot", id: "tab-1" },
        env,
      );
      for (const text of ["Delete account", "Cancel", "Save"]) {
        const element = findElement(
          snapshot.elements,
          (candidate) => candidate.text === text,
        );
        await executeDesktopBrowserWorkspaceDomCommand(
          { subaction: "click", id: "tab-1", selector: element.ref },
          env,
        );
      }

      expect(clicked).toEqual(["Delete account", "Cancel", "Save"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
