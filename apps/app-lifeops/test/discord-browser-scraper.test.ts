import { afterEach, beforeEach, describe, expect, test } from "vitest";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { JSDOM } from "jsdom";
import {
  captureDiscordDeliveryStatus,
  closeDiscordTab,
  discordBrowserWorkspaceAvailable,
  discordPartitionFor,
  ensureDiscordTab,
  probeDiscordDocumentState,
  probeDiscordTab,
  searchDiscordMessages,
  type DiscordMessageSearchResult,
} from "../src/lifeops/discord-browser-scraper.js";

interface RecordedRequest {
  method: string;
  pathname: string;
  body: unknown;
  auth: string | null;
}

interface BridgeFixture {
  baseUrl: string;
  token: string;
  requests: RecordedRequest[];
  tabs: Map<string, { id: string; url: string; partition: string; title?: string }>;
  evalResult: unknown;
  close: () => Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startFakeBridge(): Promise<BridgeFixture> {
  const token = "test-token";
  const fixture: Partial<BridgeFixture> = {
    token,
    requests: [],
    tabs: new Map(),
    evalResult: null,
  };
  let tabCounter = 1;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = ["POST", "PUT", "PATCH"].includes(req.method ?? "")
      ? await readJson(req)
      : null;
    fixture.requests?.push({
      method: req.method ?? "",
      pathname: url.pathname,
      body,
      auth: req.headers.authorization ?? null,
    });

    if (req.headers.authorization !== `Bearer ${token}`) {
      send(res, 401, { error: "unauthorized" });
      return;
    }

    if (url.pathname === "/tabs" && req.method === "GET") {
      send(res, 200, { tabs: Array.from(fixture.tabs!.values()) });
      return;
    }
    if (url.pathname === "/tabs" && req.method === "POST") {
      const payload = (body ?? {}) as Record<string, unknown>;
      const id = `tab_${tabCounter++}`;
      const tab = {
        id,
        url: typeof payload.url === "string" ? payload.url : "about:blank",
        partition:
          typeof payload.partition === "string" ? payload.partition : "",
        title: typeof payload.title === "string" ? payload.title : undefined,
      };
      fixture.tabs!.set(id, tab);
      send(res, 200, { tab });
      return;
    }

    const match = url.pathname.match(
      /^\/tabs\/([^/]+)(?:\/(navigate|eval|show|hide|snapshot))?$/,
    );
    if (!match) {
      send(res, 404, { error: "not found" });
      return;
    }
    const tabId = decodeURIComponent(match[1]);
    const action = match[2];

    if (!action && req.method === "DELETE") {
      const existed = fixture.tabs!.delete(tabId);
      send(res, existed ? 200 : 404, { closed: existed });
      return;
    }
    if (action === "show" && req.method === "POST") {
      const tab = fixture.tabs!.get(tabId);
      send(res, tab ? 200 : 404, tab ? { tab } : { error: "not found" });
      return;
    }
    if (action === "navigate" && req.method === "POST") {
      const tab = fixture.tabs!.get(tabId);
      if (!tab) {
        send(res, 404, { error: "not found" });
        return;
      }
      const nextUrl =
        (body as { url?: string } | null)?.url ?? tab.url;
      fixture.tabs!.set(tabId, { ...tab, url: nextUrl });
      send(res, 200, { tab: fixture.tabs!.get(tabId) });
      return;
    }
    if (action === "eval" && req.method === "POST") {
      send(res, 200, { result: fixture.evalResult });
      return;
    }

    send(res, 405, { error: "method not allowed" });
  });

  const port: number = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("bad address"));
        return;
      }
      resolve(addr.port);
    });
  });

  fixture.baseUrl = `http://127.0.0.1:${port}`;
  fixture.close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  return fixture as BridgeFixture;
}

describe("discord browser scraper (end-to-end vs fake bridge)", () => {
  let bridge: BridgeFixture;
  const originalUrl = process.env.ELIZA_BROWSER_WORKSPACE_URL;
  const originalToken = process.env.ELIZA_BROWSER_WORKSPACE_TOKEN;

  beforeEach(async () => {
    bridge = await startFakeBridge();
    process.env.ELIZA_BROWSER_WORKSPACE_URL = bridge.baseUrl;
    process.env.ELIZA_BROWSER_WORKSPACE_TOKEN = bridge.token;
  });

  afterEach(async () => {
    await bridge.close();
    if (originalUrl === undefined) {
      delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
    } else {
      process.env.ELIZA_BROWSER_WORKSPACE_URL = originalUrl;
    }
    if (originalToken === undefined) {
      delete process.env.ELIZA_BROWSER_WORKSPACE_TOKEN;
    } else {
      process.env.ELIZA_BROWSER_WORKSPACE_TOKEN = originalToken;
    }
  });

  test("reports available when bridge is configured", () => {
    expect(discordBrowserWorkspaceAvailable()).toBe(true);
  });

  test("partition is deterministic per agent+side", () => {
    expect(discordPartitionFor("agent-1", "owner")).toBe(
      "lifeops-discord-agent-1-owner",
    );
    expect(discordPartitionFor("agent-1", "agent")).toBe(
      "lifeops-discord-agent-1-agent",
    );
  });

  test("ensureDiscordTab opens a Discord tab when none exists", async () => {
    const result = await ensureDiscordTab({
      agentId: "agent-42",
      side: "owner",
      show: true,
    });

    expect(result.url).toBe("https://discord.com/channels/@me");
    expect(result.tabId).toMatch(/^tab_/);

    const createRequest = bridge.requests.find(
      (r) => r.method === "POST" && r.pathname === "/tabs",
    );
    expect(createRequest?.body).toMatchObject({
      url: "https://discord.com/channels/@me",
      partition: "lifeops-discord-agent-42-owner",
      show: true,
    });
  });

  test("ensureDiscordTab reuses an existing tab for the same partition", async () => {
    const first = await ensureDiscordTab({
      agentId: "agent-42",
      side: "owner",
      show: true,
    });
    const second = await ensureDiscordTab({
      agentId: "agent-42",
      side: "owner",
      existingTabId: first.tabId,
      show: true,
    });

    expect(second.tabId).toBe(first.tabId);
    const createRequests = bridge.requests.filter(
      (r) => r.method === "POST" && r.pathname === "/tabs",
    );
    expect(createRequests).toHaveLength(1);
    const showRequests = bridge.requests.filter(
      (r) => r.pathname === `/tabs/${first.tabId}/show`,
    );
    expect(showRequests.length).toBeGreaterThanOrEqual(1);
  });

  test("probeDiscordTab reports loggedIn=false when bridge returns null probe", async () => {
    const tab = await ensureDiscordTab({
      agentId: "agent-42",
      side: "owner",
      show: true,
    });
    bridge.evalResult = null;

    const probe = await probeDiscordTab(tab.tabId);
    expect(probe.loggedIn).toBe(false);
    expect(probe.identity).toEqual({
      id: null,
      username: null,
      discriminator: null,
    });
    expect(probe.dmInbox).toEqual({
      visible: false,
      count: 0,
      selectedChannelId: null,
      previews: [],
    });
  });

  test("probeDiscordTab surfaces identity returned by DOM probe", async () => {
    const tab = await ensureDiscordTab({
      agentId: "agent-42",
      side: "owner",
      show: true,
    });
    bridge.evalResult = {
      loggedIn: true,
      url: "https://discord.com/channels/@me",
      identity: {
        id: null,
        username: "shaw",
        discriminator: "0001",
      },
      rawSnippet: "shaw | @shaw",
      dmInbox: {
        visible: true,
        count: 2,
        selectedChannelId: "222",
        previews: [
          {
            channelId: "111",
            href: "/channels/@me/111",
            label: "Alice",
            selected: false,
            unread: true,
            snippet: "Are we meeting tomorrow?",
          },
          {
            channelId: "222",
            href: "/channels/@me/222",
            label: "Bob",
            selected: true,
            unread: false,
            snippet: "Sent you the file",
          },
        ],
      },
    };

    const probe = await probeDiscordTab(tab.tabId);
    expect(probe.loggedIn).toBe(true);
    expect(probe.identity.username).toBe("shaw");
    expect(probe.identity.discriminator).toBe("0001");
    expect(probe.dmInbox.visible).toBe(true);
    expect(probe.dmInbox.count).toBe(2);
    expect(probe.dmInbox.selectedChannelId).toBe("222");
    expect(probe.dmInbox.previews[0]).toMatchObject({
      label: "Alice",
      unread: true,
    });

    const evalRequest = bridge.requests.find((r) =>
      r.pathname.endsWith("/eval"),
    );
    expect(evalRequest).toBeDefined();
    expect(typeof (evalRequest?.body as { script?: string })?.script).toBe(
      "string",
    );
  });

  test("probeDiscordDocumentState detects visible DMs from Discord DOM", () => {
    const dom = new JSDOM(
      `
        <body>
          <nav data-list-id="guildsnav"></nav>
          <section aria-label="User area">
            <div class="nameTag">
              <span class="name-">shaw</span>
              <span class="discrim">#0001</span>
            </div>
          </section>
          <a href="/channels/@me/111" aria-label="Alice, unread messages">
            <div>Alice</div>
            <div>Are we meeting tomorrow?</div>
            <div class="unread-indicator"></div>
          </a>
          <a href="/channels/@me/222" aria-current="page">
            <div>Bob</div>
            <div>Sent you the file</div>
          </a>
        </body>
      `,
      { url: "https://discord.com/channels/@me/222" },
    );

    const probe = probeDiscordDocumentState(
      dom.window.document,
      dom.window.location.href,
    );

    expect(probe.loggedIn).toBe(true);
    expect(probe.identity).toEqual({
      id: null,
      username: "shaw",
      discriminator: "0001",
    });
    expect(probe.dmInbox.visible).toBe(true);
    expect(probe.dmInbox.count).toBe(2);
    expect(probe.dmInbox.selectedChannelId).toBe("222");
    expect(probe.dmInbox.previews).toMatchObject([
      {
        channelId: "111",
        label: "Alice",
        unread: true,
        snippet: "Are we meeting tomorrow?",
      },
      {
        channelId: "222",
        label: "Bob",
        selected: true,
        unread: false,
        snippet: "Sent you the file",
      },
    ]);
  });

  test("closeDiscordTab removes the tab from the bridge", async () => {
    const tab = await ensureDiscordTab({
      agentId: "agent-42",
      side: "owner",
      show: true,
    });
    await closeDiscordTab(tab.tabId);

    const listing = bridge.tabs;
    expect(listing.has(tab.tabId)).toBe(false);
    const deleteRequest = bridge.requests.find(
      (r) => r.method === "DELETE" && r.pathname === `/tabs/${tab.tabId}`,
    );
    expect(deleteRequest).toBeDefined();
  });
});

describe("searchDiscordMessages (fake bridge)", () => {
  let bridge: BridgeFixture;
  const originalUrl = process.env.ELIZA_BROWSER_WORKSPACE_URL;
  const originalToken = process.env.ELIZA_BROWSER_WORKSPACE_TOKEN;

  beforeEach(async () => {
    bridge = await startFakeBridge();
    process.env.ELIZA_BROWSER_WORKSPACE_URL = bridge.baseUrl;
    process.env.ELIZA_BROWSER_WORKSPACE_TOKEN = bridge.token;
  });

  afterEach(async () => {
    await bridge.close();
    if (originalUrl === undefined) {
      delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
    } else {
      process.env.ELIZA_BROWSER_WORKSPACE_URL = originalUrl;
    }
    if (originalToken === undefined) {
      delete process.env.ELIZA_BROWSER_WORKSPACE_TOKEN;
    } else {
      process.env.ELIZA_BROWSER_WORKSPACE_TOKEN = originalToken;
    }
  });

  test("injects search script then reads results from DOM eval", async () => {
    // Pre-create a fake tab so searchDiscordMessages has a tabId.
    bridge.tabs.set("tab_search1", {
      id: "tab_search1",
      url: "https://discord.com/channels/@me",
      partition: "lifeops-discord-agent-1-owner",
    });

    const expectedResults: DiscordMessageSearchResult[] = [
      {
        id: "123456789012345678",
        content: "the quick brown fox",
        authorName: "alice",
        channelId: "999",
        timestamp: "2026-04-17T10:00:00.000Z",
        deliveryStatus: "unknown",
      },
    ];

    // The fake bridge returns evalResult for every eval call.
    // First eval (inject search script) → bridge returns null (injected=false is fine).
    // Second eval (read results panel) → return the expected results array.
    let evalCallCount = 0;
    const origEvalResult = bridge.evalResult;
    Object.defineProperty(bridge, "evalResult", {
      get() {
        evalCallCount += 1;
        // First call: search injection acknowledgement.
        if (evalCallCount === 1) return { injected: true };
        // Second call: results panel DOM scrape.
        return expectedResults;
      },
      configurable: true,
    });

    const results = await searchDiscordMessages({
      tabId: "tab_search1",
      query: "quick brown fox",
      env: process.env,
    });

    expect(Array.isArray(results)).toBe(true);
    expect(results).toEqual(expectedResults);

    // Verify that the bridge received at least two eval calls (inject + read).
    const evalRequests = bridge.requests.filter((r) =>
      r.pathname.endsWith("/eval"),
    );
    expect(evalRequests.length).toBeGreaterThanOrEqual(2);

    // Restore.
    Object.defineProperty(bridge, "evalResult", {
      value: origEvalResult,
      configurable: true,
      writable: true,
    });
  });

  test("returns empty array when eval result is not an array", async () => {
    bridge.tabs.set("tab_search2", {
      id: "tab_search2",
      url: "https://discord.com/channels/@me",
      partition: "lifeops-discord-agent-1-owner",
    });
    // Bridge always returns null — search injection may fail, results panel empty.
    bridge.evalResult = null;

    const results = await searchDiscordMessages({
      tabId: "tab_search2",
      query: "no results expected",
      env: process.env,
    });

    expect(results).toEqual([]);
  });

  test("rejects empty query string", async () => {
    bridge.tabs.set("tab_search3", {
      id: "tab_search3",
      url: "https://discord.com/channels/@me",
      partition: "lifeops-discord-agent-1-owner",
    });
    bridge.evalResult = null;

    await expect(
      searchDiscordMessages({
        tabId: "tab_search3",
        query: "   ",
        env: process.env,
      }),
    ).rejects.toThrow(/query must not be empty/i);
  });
});

describe("captureDiscordDeliveryStatus (fake bridge)", () => {
  let bridge: BridgeFixture;
  const originalUrl = process.env.ELIZA_BROWSER_WORKSPACE_URL;
  const originalToken = process.env.ELIZA_BROWSER_WORKSPACE_TOKEN;

  beforeEach(async () => {
    bridge = await startFakeBridge();
    process.env.ELIZA_BROWSER_WORKSPACE_URL = bridge.baseUrl;
    process.env.ELIZA_BROWSER_WORKSPACE_TOKEN = bridge.token;
  });

  afterEach(async () => {
    await bridge.close();
    if (originalUrl === undefined) {
      delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
    } else {
      process.env.ELIZA_BROWSER_WORKSPACE_URL = originalUrl;
    }
    if (originalToken === undefined) {
      delete process.env.ELIZA_BROWSER_WORKSPACE_TOKEN;
    } else {
      process.env.ELIZA_BROWSER_WORKSPACE_TOKEN = originalToken;
    }
  });

  test("returns DOM-scraped delivery results from the active channel", async () => {
    bridge.tabs.set("tab_delivery1", {
      id: "tab_delivery1",
      url: "https://discord.com/channels/@me/555",
      partition: "lifeops-discord-agent-1-owner",
    });

    const domResults: DiscordMessageSearchResult[] = [
      {
        id: "111111111111111111",
        content: "sent message",
        authorName: null,
        channelId: "555",
        timestamp: "2026-04-17T09:00:00.000Z",
        deliveryStatus: "sent",
      },
      {
        id: "222222222222222222",
        content: "sending in progress",
        authorName: null,
        channelId: "555",
        timestamp: "2026-04-17T09:01:00.000Z",
        deliveryStatus: "sending",
      },
      {
        id: "333333333333333333",
        content: "failed to send",
        authorName: null,
        channelId: "555",
        timestamp: "2026-04-17T09:02:00.000Z",
        deliveryStatus: "failed",
      },
    ];
    bridge.evalResult = domResults;

    const results = await captureDiscordDeliveryStatus({
      tabId: "tab_delivery1",
      env: process.env,
    });

    expect(results).toEqual(domResults);
    // Verify delivery statuses are preserved as returned by the DOM script.
    expect(results.map((r) => r.deliveryStatus)).toEqual([
      "sent",
      "sending",
      "failed",
    ]);
  });

  test("returns empty array when no messages are rendered", async () => {
    bridge.tabs.set("tab_delivery2", {
      id: "tab_delivery2",
      url: "https://discord.com/channels/@me",
      partition: "lifeops-discord-agent-1-owner",
    });
    bridge.evalResult = [];

    const results = await captureDiscordDeliveryStatus({
      tabId: "tab_delivery2",
      env: process.env,
    });

    expect(results).toEqual([]);
  });
});

describe("discord browser scraper (bridge not configured)", () => {
  const originalUrl = process.env.ELIZA_BROWSER_WORKSPACE_URL;

  beforeEach(() => {
    delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
  });
  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
    } else {
      process.env.ELIZA_BROWSER_WORKSPACE_URL = originalUrl;
    }
  });

  test("reports unavailable without env var", () => {
    expect(discordBrowserWorkspaceAvailable()).toBe(false);
  });

  test("ensureDiscordTab throws a clear error when unavailable", async () => {
    await expect(
      ensureDiscordTab({ agentId: "a", side: "owner", show: true }),
    ).rejects.toThrow(/browser workspace/i);
  });
});
