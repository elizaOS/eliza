/**
 * Real Chromium proof for the web-hosted Browser workspace: isolated page
 * execution, live frames, pointer/keyboard input, and deterministic teardown.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  browserWorkspaceChromiumEngine,
  closeChromiumBrowserWorkspaceTab,
  dispatchChromiumBrowserWorkspaceInput,
  evaluateChromiumBrowserWorkspaceTab,
  executeChromiumBrowserWorkspaceCommand,
  getChromiumBrowserWorkspaceSnapshot,
  openChromiumBrowserWorkspaceTab,
  resizeChromiumBrowserWorkspaceTab,
  stopChromiumBrowserWorkspace,
  subscribeChromiumBrowserWorkspaceFrames,
  usesChromiumBrowserWorkspace,
} from "../browser-workspace-chromium.js";

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html><body>
        <label>Name <input id="name" /></label>
        <button id="save" onclick="document.body.dataset.saved = document.querySelector('#name').value">Save</button>
      </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await stopChromiumBrowserWorkspace();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("Chromium Browser workspace", () => {
  it("selects local, hosted, and test-only document engines explicitly", () => {
    expect(usesChromiumBrowserWorkspace({ NODE_ENV: "test" })).toBe(false);
    expect(
      usesChromiumBrowserWorkspace({
        NODE_ENV: "test",
        ELIZA_BROWSER_WORKSPACE_BACKEND: "hosted-chromium",
      }),
    ).toBe(true);
    expect(
      usesChromiumBrowserWorkspace({
        NODE_ENV: "production",
        ELIZA_BROWSER_WORKSPACE_BACKEND: "document-emulation",
      }),
    ).toBe(false);
    expect(
      browserWorkspaceChromiumEngine({
        ELIZA_BROWSER_CDP_URL: "wss://browser.example.test/session",
      }),
    ).toBe("hosted-chromium");
    expect(
      browserWorkspaceChromiumEngine({
        ELIZA_BROWSER_WORKSPACE_BACKEND: "hosted-chromium",
      }),
    ).toBe("hosted-chromium");
    expect(browserWorkspaceChromiumEngine({})).toBe("local-chromium");
  });

  it("streams and controls a real isolated page", async () => {
    const tab = await openChromiumBrowserWorkspaceTab({
      url: origin,
      show: true,
      width: 800,
      height: 500,
    });
    expect(await getChromiumBrowserWorkspaceSnapshot()).toMatchObject({
      engine: "local-chromium",
      mode: "web",
      presentation: "remote-stream",
      tabs: [expect.objectContaining({ id: tab.id, url: `${origin}/` })],
    });

    await resizeChromiumBrowserWorkspaceTab(tab.id, {
      width: 640,
      height: 400,
    });
    const firstFrame = new Promise<{
      data: string;
      width: number;
      height: number;
    }>((resolve) => {
      void subscribeChromiumBrowserWorkspaceFrames(tab.id, resolve).then(
        (unsubscribe) => {
          void firstFrame.finally(unsubscribe);
        },
      );
    });

    const inputRect = await evaluateChromiumBrowserWorkspaceTab(
      tab.id,
      `(() => {
        const rect = document.querySelector('#name').getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()`,
    );
    expect(inputRect).toEqual(
      expect.objectContaining({
        height: expect.any(Number),
        width: expect.any(Number),
        x: expect.any(Number),
        y: expect.any(Number),
      }),
    );
    const rect = inputRect as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await dispatchChromiumBrowserWorkspaceInput(tab.id, {
      type: "pointer",
      phase: "down",
      button: "left",
      x,
      y,
    });
    await dispatchChromiumBrowserWorkspaceInput(tab.id, {
      type: "pointer",
      phase: "up",
      button: "left",
      x,
      y,
    });
    await dispatchChromiumBrowserWorkspaceInput(tab.id, {
      type: "text",
      text: "Eliza",
    });

    await expect(
      evaluateChromiumBrowserWorkspaceTab(
        tab.id,
        "document.querySelector('#name').value",
      ),
    ).resolves.toBe("Eliza");

    const inspected = await executeChromiumBrowserWorkspaceCommand({
      subaction: "inspect",
      id: tab.id,
    });
    const input = inspected.elements?.find(
      (element) => element.selector === "#name",
    );
    const save = inspected.elements?.find(
      (element) => element.selector === "#save",
    );
    expect(input?.ref).toMatch(/^@e\d+$/);
    expect(save?.ref).toMatch(/^@e\d+$/);
    await executeChromiumBrowserWorkspaceCommand({
      subaction: "fill",
      id: tab.id,
      selector: input?.ref,
      text: "Real browser ref",
    });
    await executeChromiumBrowserWorkspaceCommand({
      subaction: "click",
      id: tab.id,
      selector: save?.ref,
    });
    await expect(
      evaluateChromiumBrowserWorkspaceTab(
        tab.id,
        "document.body.dataset.saved",
      ),
    ).resolves.toBe("Real browser ref");

    await expect(firstFrame).resolves.toMatchObject({
      data: expect.stringMatching(/^[A-Za-z0-9+/]+=*$/),
      height: expect.any(Number),
      width: expect.any(Number),
    });
    await expect(closeChromiumBrowserWorkspaceTab(tab.id)).resolves.toBe(true);
  });
});
