/**
 * Desktop page scripts never return a password or hidden input value: inspect,
 * snapshot, the snapshot record behind diff and pdf, get value, and the
 * fill/type/paste echoes name the control but leave its value out, and
 * clipboard copy refuses them.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { executeBrowserWorkspaceCommand } from "../browser-workspace.js";
import {
  createDesktopBrowserWorkspaceCommandScript,
  createDesktopBrowserWorkspaceUtilityScript,
  getDesktopBrowserWorkspaceSnapshotRecord,
} from "../browser-workspace-desktop.js";
import type { BrowserWorkspaceCommand } from "../browser-workspace-types.js";

const PASSWORD = "PASSWORD_SECRET_1";
const TOKEN = "CSRF_SECRET_2";
const FORM = `<form>
  <input id="user" name="user" value="ada">
  <input id="pw" name="pw" type="password" value="${PASSWORD}">
  <input id="csrf" name="csrf" type="hidden" value="${TOKEN}">
</form>`;

const pages: JSDOM[] = [];

afterEach(() => {
  for (const dom of pages.splice(0)) dom.window.close();
});

function openPage(): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>${FORM}</body></html>`, {
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

function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(TOKEN);
}

/** A desktop bridge whose tab evaluates posted scripts in a JSDOM page. */
async function withBridge(
  dom: JSDOM,
  run: (env: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      if (/\/eval$/.test(request.url ?? "")) {
        const { script } = JSON.parse(body) as { script: string };
        response.end(JSON.stringify({ result: dom.window.eval(script) }));
        return;
      }
      response.end(JSON.stringify({ tabs: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({ ELIZA_BROWSER_WORKSPACE_URL: `http://127.0.0.1:${port}` });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("desktop private control redaction", () => {
  it("leaves values out of inspect and snapshot elements", () => {
    const dom = openPage();

    const inspected = command(dom, { subaction: "inspect" }) as {
      elements: Array<{ name: string | null; value: string | null }>;
    };
    const snapshot = command(dom, { subaction: "snapshot" });

    expectNoSecrets(inspected);
    expectNoSecrets(snapshot);
    expect(inspected.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "user", value: "ada" }),
        expect.objectContaining({ name: "pw", value: null }),
        expect.objectContaining({ name: "csrf", value: null }),
      ]),
    );
  });

  it("returns no value from get value", () => {
    const dom = openPage();

    expect(
      command(dom, { subaction: "get", getMode: "value", selector: "#pw" }),
    ).toEqual({ value: null });
    expect(
      command(dom, { subaction: "get", getMode: "value", selector: "#csrf" }),
    ).toEqual({ value: null });
    expect(
      command(dom, { subaction: "get", getMode: "value", selector: "#user" }),
    ).toEqual({ value: "ada" });
  });

  it("fills a password field without echoing the value", () => {
    const dom = openPage();
    const input = dom.window.document.querySelector("#pw") as HTMLInputElement;

    for (const subaction of ["fill", "type", "keyboardinserttext"] as const) {
      const result = command(dom, { subaction, selector: "#pw", value: "x" });
      expectNoSecrets(result);
      expect(result).toMatchObject({ value: null });
    }
    expect(input.value).toBe("xxx");

    const pasted = dom.window.eval(
      createDesktopBrowserWorkspaceUtilityScript(
        { subaction: "clipboard", clipboardAction: "paste", selector: "#pw" },
        { clipboardText: "y" },
      ),
    );
    expectNoSecrets(pasted);
    expect(pasted).toMatchObject({ value: null });
    expect(input.value).toBe("xxxy");

    expect(() =>
      dom.window.eval(
        createDesktopBrowserWorkspaceUtilityScript({
          subaction: "clipboard",
          clipboardAction: "copy",
          selector: "#csrf",
        }),
      ),
    ).toThrow("cannot be copied");
  });

  it("names private controls in the snapshot record and diff", async () => {
    const dom = openPage();

    await withBridge(dom, async (env) => {
      const record = await getDesktopBrowserWorkspaceSnapshotRecord(
        { subaction: "diff", id: "tab-r" },
        env,
      );
      expectNoSecrets(record);
      expect(record.bodyText).toContain("user:ada");
      expect(record.bodyText).toMatch(/\bpw\b/);
      expect(record.bodyText).toMatch(/\bcsrf\b/);

      const diff = await executeBrowserWorkspaceCommand(
        { subaction: "diff", diffAction: "snapshot", id: "tab-r" },
        env,
      );
      expectNoSecrets(diff);
    });
  });
});
