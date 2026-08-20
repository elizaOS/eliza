/** Exercises malformed browser-workspace tab identifiers at the bridge boundary. */

import http from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const closeTab = vi.hoisted(() =>
  vi.fn(async (options: { id: string }) => options.id === "tab-1"),
);

vi.mock("./native/browser-workspace", () => ({
  getBrowserWorkspaceManager: () => ({
    listTabs: async () => ({ tabs: [] }),
    closeTab,
    snapshotTab: async () => {
      throw new Error("snapshotTab must not run on malformed encoding");
    },
    showTab: async () => {
      throw new Error("showTab must not run on malformed encoding");
    },
    hideTab: async () => {
      throw new Error("hideTab must not run on malformed encoding");
    },
    navigateTab: async () => {
      throw new Error("navigateTab must not run on malformed encoding");
    },
    evaluateTab: async () => {
      throw new Error("evaluateTab must not run on malformed encoding");
    },
  }),
}));

const { startBrowserWorkspaceBridgeServer } = await import(
  "./browser-workspace-bridge-server"
);

const savedUrl = process.env.ELIZA_BROWSER_WORKSPACE_URL;
const savedToken = process.env.ELIZA_BROWSER_WORKSPACE_TOKEN;
const savedPort = process.env.ELIZA_BROWSER_WORKSPACE_PORT;

let stop: (() => void) | undefined;

async function request(
  method: string,
  path: string,
  token: string,
  port: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(body) as Record<string, unknown>,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("electrobun browser-workspace tab id encoding", () => {
  let nextPort = 31991;
  beforeEach(() => {
    closeTab.mockClear();
    // A fresh port per test: the previous server's close is asynchronous, and
    // reusing its port races the shutdown into ECONNRESET under vitest.
    nextPort += 1;
    process.env.ELIZA_BROWSER_WORKSPACE_PORT = String(nextPort);
    process.env.ELIZA_BROWSER_WORKSPACE_TOKEN = "test-tab-encoding-token";
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    if (savedUrl === undefined) delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
    else process.env.ELIZA_BROWSER_WORKSPACE_URL = savedUrl;
    if (savedToken === undefined)
      delete process.env.ELIZA_BROWSER_WORKSPACE_TOKEN;
    else process.env.ELIZA_BROWSER_WORKSPACE_TOKEN = savedToken;
    if (savedPort === undefined)
      delete process.env.ELIZA_BROWSER_WORKSPACE_PORT;
    else process.env.ELIZA_BROWSER_WORKSPACE_PORT = savedPort;
  });

  async function startBridge() {
    stop = await startBrowserWorkspaceBridgeServer();
    const base = process.env.ELIZA_BROWSER_WORKSPACE_URL ?? "";
    const token = process.env.ELIZA_BROWSER_WORKSPACE_TOKEN ?? "";
    const port = Number(new URL(base).port);
    return { token, port };
  }

  test("canonical tab id still reaches closeTab", async () => {
    const { token, port } = await startBridge();
    const response = await request("DELETE", "/tabs/tab-1", token, port);
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ closed: true });
    expect(closeTab).toHaveBeenCalledWith({ id: "tab-1" });
  });

  test("canonical percent-encoded hyphen still decodes before closeTab", async () => {
    const { token, port } = await startBridge();
    const response = await request("DELETE", "/tabs/tab%2D1", token, port);
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ closed: true });
    expect(closeTab).toHaveBeenCalledWith({ id: "tab-1" });
  });

  test.each(["%", "%2", "%ZZ", "%E0%A4"])(
    "rejects malformed tab id %s with 400 before closeTab",
    async (tokenId) => {
      const { token, port } = await startBridge();
      const response = await request("DELETE", `/tabs/${tokenId}`, token, port);
      expect(response.status).toBe(400);
      expect(response.json).toEqual({
        error: "invalid tab id: malformed URL encoding",
      });
      expect(closeTab).not.toHaveBeenCalled();
    },
  );
});
