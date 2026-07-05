/**
 * Startup default-search-tab coverage for the browser workspace (#13596).
 *
 * Drives the real web-mode (JSDOM) path: no network, no desktop bridge, so the
 * seeding + idempotency + non-blocking guarantees are exercised in-process.
 * Also drives `BrowserService.start` to assert the service wires the default
 * tab at boot.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserService } from "../../browser-service.js";
import {
  __resetBrowserWorkspaceStateForTests,
  BROWSER_WORKSPACE_DEFAULT_SEARCH_URL,
  ensureBrowserWorkspaceDefaultTab,
  ensureBrowserWorkspaceDefaultTabWithRetry,
  executeBrowserWorkspaceCommand,
  listBrowserWorkspaceTabs,
  resolveBrowserWorkspaceDefaultSearchUrl,
} from "../browser-workspace.js";

const webEnv: NodeJS.ProcessEnv = {};

describe("browser workspace default search tab (web mode)", () => {
  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
  });

  it("seeds exactly one visible tab pointed at a real search site (not about:blank)", async () => {
    expect(await listBrowserWorkspaceTabs(webEnv)).toHaveLength(0);

    const tab = await ensureBrowserWorkspaceDefaultTab(webEnv);

    expect(tab.url).toBe(BROWSER_WORKSPACE_DEFAULT_SEARCH_URL);
    expect(tab.url).not.toBe("about:blank");
    expect(tab.visible).toBe(true);

    const tabs = await listBrowserWorkspaceTabs(webEnv);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.url).toBe(BROWSER_WORKSPACE_DEFAULT_SEARCH_URL);
    // Default search endpoint is a real https HTML page.
    expect(new URL(tabs[0]?.url ?? "").protocol).toBe("https:");
  });

  it("is idempotent — a second call never spawns a duplicate tab", async () => {
    const first = await ensureBrowserWorkspaceDefaultTab(webEnv);
    const second = await ensureBrowserWorkspaceDefaultTab(webEnv);

    expect(second.id).toBe(first.id);
    expect(await listBrowserWorkspaceTabs(webEnv)).toHaveLength(1);
  });

  it("leaves an already-populated workspace untouched", async () => {
    const opened = await executeBrowserWorkspaceCommand(
      { subaction: "tab", tabAction: "new", url: "https://example.com/" },
      webEnv,
    );
    const openedId = opened.tab?.id as string;

    const resolved = await ensureBrowserWorkspaceDefaultTab(webEnv);

    // No default tab is seeded on top of an existing session.
    expect(resolved.id).toBe(openedId);
    const tabs = await listBrowserWorkspaceTabs(webEnv);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.url).toBe("https://example.com/");
  });

  it("does not block agent tab actions while the default tab is loading", async () => {
    // The default tab is seeded but never navigated/loaded here — the agent
    // must still be able to open a fresh tab immediately.
    await ensureBrowserWorkspaceDefaultTab(webEnv);

    const created = await executeBrowserWorkspaceCommand(
      {
        subaction: "tab",
        tabAction: "new",
        url: "https://agent.example/task",
      },
      webEnv,
    );
    expect(created.tab?.url).toBe("https://agent.example/task");

    const tabs = await listBrowserWorkspaceTabs(webEnv);
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => tab.url)).toContain(
      BROWSER_WORKSPACE_DEFAULT_SEARCH_URL,
    );
  });

  it("honors the ELIZA_BROWSER_DEFAULT_SEARCH_URL override", async () => {
    const overrideEnv: NodeJS.ProcessEnv = {
      ELIZA_BROWSER_DEFAULT_SEARCH_URL: "https://lite.duckduckgo.com/lite/",
    };
    expect(resolveBrowserWorkspaceDefaultSearchUrl(overrideEnv)).toBe(
      "https://lite.duckduckgo.com/lite/",
    );

    const tab = await ensureBrowserWorkspaceDefaultTab(overrideEnv);
    expect(tab.url).toBe("https://lite.duckduckgo.com/lite/");
  });

  it("rejects a non-http override rather than seeding a broken tab", () => {
    expect(() =>
      resolveBrowserWorkspaceDefaultSearchUrl({
        ELIZA_BROWSER_DEFAULT_SEARCH_URL: "about:blank",
      }),
    ).toThrow();
  });

  it("retries desktop bridge seeding when the bridge is still warming up", async () => {
    const originalFetch = globalThis.fetch;
    const env: NodeJS.ProcessEnv = {
      ELIZA_BROWSER_WORKSPACE_URL: "http://workspace-bridge.test",
    };
    const seededTab = {
      id: "tab-default",
      title: "DuckDuckGo",
      url: BROWSER_WORKSPACE_DEFAULT_SEARCH_URL,
      visible: true,
      kind: "search",
    };
    const requests: string[] = [];
    let requestCount = 0;
    globalThis.fetch = vi.fn(async (input, init) => {
      requestCount++;
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (requestCount === 1) {
        throw new Error("desktop bridge warming up");
      }
      if (url.pathname === "/tabs" && !init?.method) {
        return Response.json({ tabs: [] });
      }
      if (url.pathname === "/tabs" && init.method === "POST") {
        return Response.json({ tab: seededTab });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    }) as typeof fetch;

    try {
      const tab = await ensureBrowserWorkspaceDefaultTabWithRetry(env, {
        attempts: 2,
        retryDelayMs: 1,
        sleepFn: async () => undefined,
      });

      expect(tab).toEqual(seededTab);
      expect(requests).toEqual(["GET /tabs", "GET /tabs", "POST /tabs"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("BrowserService seeds the default tab at start", () => {
  const bridgeKeys = [
    "ELIZA_BROWSER_WORKSPACE_URL",
    "ELIZA_BROWSER_WORKSPACE_TOKEN",
  ];
  const savedBridge: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of bridgeKeys) {
      savedBridge[key] = process.env[key];
      delete process.env[key];
    }
    await __resetBrowserWorkspaceStateForTests();
  });

  it("opens one default search tab when the service boots in web mode", async () => {
    const runtime = {
      getService: () => null,
    } as unknown as IAgentRuntime;

    const service = await BrowserService.start(runtime);
    try {
      const tabs = await listBrowserWorkspaceTabs();
      expect(tabs).toHaveLength(1);
      expect(tabs[0]?.url).toBe(BROWSER_WORKSPACE_DEFAULT_SEARCH_URL);
      expect(tabs[0]?.visible).toBe(true);
    } finally {
      await service.stop();
      for (const key of bridgeKeys) {
        if (savedBridge[key] === undefined) delete process.env[key];
        else process.env[key] = savedBridge[key];
      }
    }
  });
});
