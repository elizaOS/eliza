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
    const callback = async (content: { text?: string }) => {
      if (userFinishedSignIn || !content.text?.startsWith("⏳")) return [];
      userFinishedSignIn = true;
      const tabs = await listBrowserWorkspaceTabs();
      const seen = tabs.find((tab) => tab.visible);
      if (!seen) throw new Error("No browser tab is visible to the user");
      await navigateBrowserWorkspaceTab({
        id: seen.id,
        url: `${origin}/oauth/callback?code=ok`,
      });
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
          timeoutMs: 3_000,
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
});
