import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
  listBrowserWorkspaceTabs,
  navigateBrowserWorkspaceTab,
} from "../workspace/browser-workspace.js";
import { browserAction } from "./browser.js";

let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><html><head><title>${request.url}</title></head><body></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
  await __resetBrowserWorkspaceStateForTests();
});

describe("BROWSER wait_for_url", () => {
  it("opens the start page where the user can finish the flow it waits on", async () => {
    await executeBrowserWorkspaceCommand({
      subaction: "open",
      url: `${origin}/home`,
      show: true,
    });

    const runtime = { getService: () => null } as unknown as IAgentRuntime;
    const message = { content: { text: "" } } as Memory;
    let userFinishedSignIn = false;
    const callback = async () => {
      // The first progress callback follows opening the visible login tab.
      // Simulate the user completing it without coupling to presentation text.
      if (userFinishedSignIn) return [];
      userFinishedSignIn = true;
      const tabs = await listBrowserWorkspaceTabs();
      const seen = tabs.find(
        (tab) => tab.visible && tab.url === `${origin}/oauth/authorize`,
      );
      if (!seen) throw new Error("No browser tab is visible to the user");
      await navigateBrowserWorkspaceTab({
        id: seen.id,
        url: `${origin}/oauth/callback?code=ok`,
      });
      const current = await executeBrowserWorkspaceCommand({
        id: seen.id,
        subaction: "get",
        getMode: "url",
      });
      expect(current.value).toContain("/oauth/callback");
      return [];
    };

    const result = await browserAction.handler?.(
      runtime,
      message,
      undefined,
      {
        parameters: {
          action: "wait_for_url",
          url: `${origin}/oauth/authorize`,
          pattern: "/oauth/callback",
          timeoutMs: 30_000,
          pollIntervalMs: 50,
        },
      },
      callback,
    );

    expect(result).toMatchObject({
      success: true,
      values: { status: "matched", matched: true },
    });
  });

  it("stops when the turn is cancelled", async () => {
    await executeBrowserWorkspaceCommand({
      subaction: "open",
      url: `${origin}/login`,
      show: true,
    });

    const runtime = { getService: () => null } as unknown as IAgentRuntime;
    const message = { content: { text: "" } } as Memory;
    const controller = new AbortController();
    const afterCancel: string[] = [];
    const callback = async (content: { text?: string }) => {
      if (controller.signal.aborted) {
        afterCancel.push(content.text ?? "");
        return [];
      }
      if (!content.text?.startsWith("⏳")) return [];
      controller.abort();
      // The page moves on after the user cancelled; that is not a match.
      const seen = (await listBrowserWorkspaceTabs()).find(
        (tab) => tab.visible,
      );
      if (!seen) throw new Error("No browser tab is visible to the user");
      await navigateBrowserWorkspaceTab({
        id: seen.id,
        url: `${origin}/done`,
      });
      return [];
    };

    const startedAt = Date.now();
    const result = await browserAction.handler?.(
      runtime,
      message,
      undefined,
      {
        abortSignal: controller.signal,
        parameters: {
          action: "wait_for_url",
          pattern: "/done",
          timeoutMs: 5_000,
          pollIntervalMs: 1_000,
        },
      },
      callback,
    );

    expect(result).toMatchObject({
      success: false,
      values: { status: "cancelled", matched: false },
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(afterCancel).toEqual([]);
  });
});
