/**
 * Element refs (`@eN`) stay bound to the element an inspect saw. The desktop
 * side runs against a local bridge that evaluates the generated page scripts
 * in a JSDOM page, so the in-page element table is the real one.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
  openBrowserWorkspaceTab,
} from "../browser-workspace.js";
import { isBrowserWorkspaceError } from "../browser-workspace-errors.js";
import type { BrowserWorkspaceCommandResult } from "../browser-workspace-types.js";

const page = `<!doctype html><html><body>
  <button id="go">Go</button>
  <div><span data-testid="card">Card A</span></div>
  <div><span data-testid="card">Card B</span></div>
</body></html>`;

interface Bridge {
  dom: JSDOM;
  env: NodeJS.ProcessEnv;
  close: () => Promise<void>;
}

async function startBridge(html: string): Promise<Bridge> {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://app.test/start",
  });
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      if (!/\/tabs\/[^/]+\/eval$/.test(request.url ?? "")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ tabs: [] }));
        return;
      }
      try {
        const { script } = JSON.parse(body) as { script: string };
        const result = await dom.window.eval(script);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ result }));
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    dom,
    env: { ELIZA_BROWSER_WORKSPACE_URL: `http://127.0.0.1:${port}` },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      dom.window.close();
    },
  };
}

function refFor(result: BrowserWorkspaceCommandResult, text: string): string {
  const ref = result.elements?.find((element) => element.text === text)?.ref;
  if (!ref) throw new Error(`no ref for ${text}`);
  return ref;
}

async function expectUnknownRef(work: Promise<unknown>): Promise<void> {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(isBrowserWorkspaceError(error)).toBe(true);
  expect(
    (error as { browserWorkspaceErrorCode?: string }).browserWorkspaceErrorCode,
  ).toBe("unknown_element_ref");
}

describe("desktop element refs", () => {
  let bridge: Bridge;

  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
    bridge = await startBridge(page);
  });

  afterEach(async () => {
    await bridge.close();
  });

  const run = (command: Parameters<typeof executeBrowserWorkspaceCommand>[0]) =>
    executeBrowserWorkspaceCommand({ id: "tab-1", ...command }, bridge.env);

  it("refuses a ref taken before a click changed the page URL", async () => {
    bridge.dom.window.document
      .getElementById("go")
      ?.addEventListener("click", () => {
        bridge.dom.window.history.pushState({}, "", "/next");
      });
    const inspected = await run({ subaction: "inspect" });
    const go = refFor(inspected, "Go");
    const card = refFor(inspected, "Card B");

    await run({ subaction: "click", selector: go });

    await expectUnknownRef(run({ subaction: "click", selector: card }));
  });

  it("refuses a ref whose element left the page", async () => {
    const inspected = await run({ subaction: "inspect" });
    const card = refFor(inspected, "Card B");
    bridge.dom.window.document
      .querySelectorAll("[data-testid='card']")[1]
      ?.remove();

    await expectUnknownRef(run({ subaction: "get", selector: card }));
  });

  it("highlights and drags by ref, each ref reaching its own duplicate", async () => {
    const inspected = await run({ subaction: "inspect" });
    const cardA = refFor(inspected, "Card A");
    const cardB = refFor(inspected, "Card B");
    const [first, second] = Array.from(
      bridge.dom.window.document.querySelectorAll("[data-testid='card']"),
    );

    await run({ subaction: "highlight", selector: cardB });
    expect(first?.hasAttribute("data-eliza-highlight")).toBe(false);
    expect(second?.hasAttribute("data-eliza-highlight")).toBe(true);

    await run({ subaction: "drag", selector: cardA, value: cardB });
    expect(first?.getAttribute("data-eliza-dragging")).toBe("true");
    expect(second?.getAttribute("data-eliza-drop-target")).toBe("true");
  });
});

describe("web element refs", () => {
  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
  });

  async function openPage(html: string): Promise<string> {
    const env = {};
    const tab = await openBrowserWorkspaceTab({ url: "about:blank" }, env);
    const url = "https://app.test/refs";
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "network",
        networkAction: "route",
        url,
        responseBody: html,
      },
      env,
    );
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url },
      env,
    );
    return tab.id;
  }

  it("clicks the Nth radio of a group by ref", async () => {
    const id = await openPage(
      `<label>S <input type="radio" name="size" value="s"></label>
       <label>M <input type="radio" name="size" value="m"></label>
       <label>L <input type="radio" name="size" value="l"></label>`,
    );
    const inspected = await executeBrowserWorkspaceCommand(
      { id, subaction: "inspect" },
      {},
    );
    const radios = inspected.elements?.filter(
      (element) => element.tag === "input",
    );
    expect(radios).toHaveLength(3);

    await executeBrowserWorkspaceCommand(
      { id, subaction: "click", selector: radios?.[2]?.ref },
      {},
    );
    const checked = await executeBrowserWorkspaceCommand(
      {
        id,
        subaction: "get",
        getMode: "value",
        selector: "css:input[value=l]",
      },
      {},
    );
    expect(checked.value).toBe(true);
  });

  it("highlights and drags by ref", async () => {
    const id = await openPage(page);
    const inspected = await executeBrowserWorkspaceCommand(
      { id, subaction: "inspect" },
      {},
    );
    const cardA = refFor(inspected, "Card A");
    const cardB = refFor(inspected, "Card B");

    const highlighted = await executeBrowserWorkspaceCommand(
      { id, subaction: "highlight", selector: cardB },
      {},
    );
    expect(highlighted.value).toEqual({
      selector: "div:nth-of-type(2) > span:nth-of-type(1)",
    });

    const dragged = await executeBrowserWorkspaceCommand(
      { id, subaction: "drag", selector: cardA, value: cardB },
      {},
    );
    expect(dragged.value).toEqual({
      source: "div:nth-of-type(1) > span:nth-of-type(1)",
      target: "div:nth-of-type(2) > span:nth-of-type(1)",
    });
  });
});
