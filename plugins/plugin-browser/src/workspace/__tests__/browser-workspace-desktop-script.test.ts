/**
 * Desktop page scripts evaluated in a JSDOM page: fill reaches a React-style
 * value tracker, the selected frame applies to command scripts, Enter submits,
 * settings are refused without touching the page, snapshots retain complete
 * authorized page prose, and back reports where the tab landed.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { isBrowserDispatchFailure } from "../../dispatch-types.js";
import { executeBrowserWorkspaceCommand } from "../browser-workspace.js";
import {
  createDesktopBrowserWorkspaceCommandScript,
  createDesktopBrowserWorkspaceUtilityScript,
  executeDesktopBrowserWorkspaceUtilityCommand,
} from "../browser-workspace-desktop.js";
import type { BrowserWorkspaceCommand } from "../browser-workspace-types.js";

const pages: JSDOM[] = [];

afterEach(() => {
  for (const dom of pages.splice(0)) dom.window.close();
});

function openPage(body: string): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    runScripts: "outside-only",
    url: "https://app.test/",
  });
  pages.push(dom);
  return dom;
}

function command(dom: JSDOM, input: BrowserWorkspaceCommand): unknown {
  const envelope = dom.window.eval(
    createDesktopBrowserWorkspaceCommandScript(input, {}),
  ) as { value: unknown };
  return envelope.value;
}

function utility(dom: JSDOM, input: BrowserWorkspaceCommand): unknown {
  return dom.window.eval(createDesktopBrowserWorkspaceUtilityScript(input));
}

/**
 * React keeps the last value it saw in an own `value` property on the node and
 * ignores an input event when the node's value still equals it. A plain
 * `element.value = x` goes through that property and updates it too.
 */
function installValueTracker(input: HTMLInputElement): () => string[] {
  const prototype = Object.getPrototypeOf(input) as HTMLInputElement;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (!descriptor?.get || !descriptor.set) throw new Error("no value setter");
  const { get, set } = descriptor;
  let tracked = get.call(input) as string;
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return get.call(this);
    },
    set(next: string) {
      tracked = String(next);
      set.call(this, next);
    },
  });
  const changes: string[] = [];
  input.addEventListener("input", () => {
    const current = get.call(input) as string;
    if (current !== tracked) {
      tracked = current;
      changes.push(current);
    }
  });
  return () => changes;
}

describe("desktop command script", () => {
  it("fills through the value setter a React tracker observes", () => {
    const dom = openPage('<input id="email">');
    const input = dom.window.document.querySelector(
      "input",
    ) as HTMLInputElement;
    const changes = installValueTracker(input);

    command(dom, { subaction: "fill", selector: "#email", value: "a@b.test" });

    expect(changes()).toEqual(["a@b.test"]);
  });

  it("clicks inside the selected frame", () => {
    const dom = openPage(
      '<button id="target">Top</button><iframe id="embed"></iframe>',
    );
    const frameDocument = dom.window.document.querySelector("iframe")
      ?.contentDocument as Document;
    frameDocument.body.innerHTML = '<button id="target">Inner</button>';
    const clicks: string[] = [];
    for (const doc of [dom.window.document, frameDocument]) {
      doc
        .querySelector("#target")
        ?.addEventListener("click", (event) =>
          clicks.push((event.target as Element).textContent ?? ""),
        );
    }

    utility(dom, { subaction: "frame", selector: "#embed" });
    command(dom, { subaction: "click", selector: "#target" });
    utility(dom, { subaction: "frame", frameAction: "main" });
    command(dom, { subaction: "click", selector: "#target" });

    expect(clicks).toEqual(["Inner", "Top"]);
  });

  it("refuses commands when the selected frame is gone", () => {
    const dom = openPage('<iframe id="embed"></iframe>');
    utility(dom, { subaction: "frame", selector: "#embed" });
    dom.window.document.querySelector("iframe")?.remove();

    expect(() =>
      command(dom, { subaction: "click", selector: "#target" }),
    ).toThrow("selected frame is not accessible");
  });

  it("submits the form on Enter after a fill and reports a key that did nothing", () => {
    const dom = openPage(
      '<form><input name="q"><button>Search</button></form><p id="plain">Text</p>',
    );
    const submits: string[] = [];
    dom.window.document
      .querySelector("form")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        submits.push(
          (dom.window.document.querySelector("input") as HTMLInputElement)
            .value,
        );
      });

    command(dom, { subaction: "fill", selector: "input", value: "socks" });
    (dom.window.document.querySelector("input") as HTMLInputElement).focus();
    expect(command(dom, { subaction: "press", key: "Enter" })).toMatchObject({
      effect: "submitted",
    });
    expect(submits).toEqual(["socks"]);

    expect(
      command(dom, { subaction: "press", key: "Enter", selector: "#plain" }),
    ).toMatchObject({ effect: "none" });
  });

  it("keeps complete snapshot output and leaves script text out", () => {
    const buttons = Array.from(
      { length: 50 },
      (_, index) => `<button>Button ${index}</button>`,
    ).join("");
    const dom = openPage(
      `<script>window.secretToken = "SCRIPT_SECRET";</script>
       <noscript>NOSCRIPT_TEXT</noscript>
       <style>.x { color: red }</style>
       <a href="/long">${"long link text ".repeat(40)}</a>
       <p>${"page prose ".repeat(3_000)}</p>${buttons}`,
    );

    const snapshot = command(dom, { subaction: "snapshot" }) as {
      bodyText: string;
      elements: Array<{ text: string }>;
      truncated: boolean;
    };

    expect(snapshot.truncated).toBe(false);
    expect(snapshot.elements).toHaveLength(51);
    expect(snapshot.elements[0]?.text).toBe(
      "long link text ".repeat(40).trim(),
    );
    expect(snapshot.bodyText).toContain("page prose ".repeat(3_000).trim());
    expect(snapshot.bodyText).toContain("Button 49");
    expect(snapshot.bodyText).not.toContain("SCRIPT_SECRET");
    expect(snapshot.bodyText).not.toContain("NOSCRIPT_TEXT");
    expect(snapshot.bodyText).not.toContain("color: red");
  });

  it("marks a label-rooted selector as CSS so it reads back as the same element", () => {
    const dom = openPage(
      '<label>A <input type="checkbox"></label><label>B <input type="checkbox"></label>',
    );

    const inspected = command(dom, { subaction: "inspect" }) as {
      elements: Array<{ selector: string }>;
    };
    const selector = inspected.elements[1]?.selector ?? "";
    expect(selector).toBe("css:label:nth-of-type(2) > input:nth-of-type(1)");

    command(dom, { subaction: "click", selector });
    utility(dom, { subaction: "highlight", selector });
    const second = dom.window.document.querySelectorAll("input")[1];
    expect((second as HTMLInputElement).checked).toBe(true);
    expect(second?.getAttribute("data-eliza-highlight")).toBe("true");
  });

  it("counts an element ref", () => {
    const dom = openPage("<button>One</button><button>Two</button>");
    const { tableId } = command(dom, { subaction: "inspect" }) as {
      tableId: string;
    };

    expect(
      command(dom, {
        subaction: "get",
        getMode: "count",
        elementRef: { tableId, index: 1 },
      }),
    ).toEqual({ value: 1 });
  });
});

describe("desktop settings", () => {
  it("refuses set credentials before reaching the page", async () => {
    const error = await executeDesktopBrowserWorkspaceUtilityCommand(
      {
        subaction: "set",
        setAction: "credentials",
        username: "user",
        password: "not-a-real-password",
        id: "tab-1",
      },
      // Nothing listens here; the command must fail before any request.
      { ELIZA_BROWSER_WORKSPACE_URL: "http://127.0.0.1:9" },
    ).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(isBrowserDispatchFailure(error)).toBe(true);
    expect((error as { kind?: string }).kind).toBe("UNSUPPORTED");
  });

  it("has no page-side settings store", () => {
    const dom = openPage('<button id="b">B</button>');

    expect(() =>
      utility(dom, {
        subaction: "set",
        setAction: "credentials",
        username: "user",
        password: "not-a-real-password",
      }),
    ).toThrow("Unsupported desktop browser workspace utility subaction");
    utility(dom, { subaction: "highlight", selector: "#b" });

    const state = (dom.window as unknown as Record<string, unknown>)
      .__elizaBrowserWorkspaceState as Record<string, unknown> | undefined;
    expect(state).toBeDefined();
    expect(state).not.toHaveProperty("settings");
    expect(JSON.stringify(state)).not.toContain("not-a-real-password");
    // Unrelated commands leave the page's console and dialogs alone.
    expect(state).not.toHaveProperty("consoleWrapped");
    expect(state).not.toHaveProperty("dialogWrapped");
  });
});

describe("desktop history commands", () => {
  it("reports the URL the tab reaches after back, not the one it left", async () => {
    // The bridge's tab moves to the previous page shortly after the script ran,
    // as history.back() does.
    let url = "https://app.test/second";
    const server = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        if (/\/eval$/.test(request.url ?? "")) {
          setTimeout(() => {
            url = "https://app.test/first";
          }, 150);
          response.end(JSON.stringify({ result: { navigating: true } }));
          return;
        }
        response.end(
          JSON.stringify({
            tabs: [
              {
                id: "tab-1",
                title: url.endsWith("first") ? "First" : "Second",
                url,
                updatedAt: url,
                visible: true,
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const result = await executeBrowserWorkspaceCommand(
        { subaction: "back", id: "tab-1" },
        { ELIZA_BROWSER_WORKSPACE_URL: `http://127.0.0.1:${port}` },
      );
      expect(result.value).toEqual({
        url: "https://app.test/first",
        title: "First",
        changed: true,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
