/**
 * Message adapter tests for reading browser bridge page contexts as messages.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BrowserBridgeAdapter } from "./message-adapter.js";

describe("BrowserBridgeAdapter", () => {
  it("declares browser bridge triage unavailable without the route service", async () => {
    const runtime = {
      agentId: "agent-1",
      getService: vi.fn(),
    } as unknown as IAgentRuntime;
    const adapter = new BrowserBridgeAdapter();

    expect(adapter.source).toBe("browser_bridge");
    expect(adapter.isAvailable(runtime)).toBe(false);
    expect(adapter.capabilities()).toMatchObject({
      list: true,
      search: false,
      channels: "implicit",
    });
    await expect(adapter.listMessages(runtime, { limit: 5 })).resolves.toEqual(
      [],
    );
  });

  it("lists the current browser page as a triage message when available", async () => {
    const page = {
      id: "page-1",
      agentId: "agent-1",
      browser: "chrome",
      profileId: "default",
      windowId: "window-1",
      tabId: "tab-1",
      url: "https://example.com/article",
      title: "Example Article",
      selectionText: null,
      mainText: "This page has useful context for the user.",
      headings: ["Example"],
      links: [{ text: "More", href: "https://example.com/more" }],
      forms: [],
      capturedAt: "2026-06-02T12:00:00.000Z",
      metadata: {},
    };
    const routeService = {
      getCurrentBrowserPage: vi.fn(async () => page),
    };
    const runtime = {
      agentId: "agent-1",
      getService: vi.fn(() => routeService),
    } as unknown as IAgentRuntime;
    const adapter = new BrowserBridgeAdapter();

    expect(adapter.isAvailable(runtime)).toBe(true);
    expect(adapter.capabilities()).toMatchObject({ list: true });

    const messages = await adapter.listMessages(runtime, { limit: 5 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      source: "browser_bridge",
      externalId: "page-1",
      threadId: "chrome:default:window-1:tab-1",
      subject: "Example Article",
      snippet: "This page has useful context for the user.",
      worldId: "default",
      channelId: "tab-1",
      metadata: {
        browser: "chrome",
        url: "https://example.com/article",
        linkCount: 1,
        formCount: 0,
      },
    });

    await expect(
      adapter.getMessage(runtime, messages[0]?.id ?? ""),
    ).resolves.toMatchObject({ externalId: "page-1" });
    await expect(
      adapter.listMessages(runtime, {
        sinceMs: Date.parse("2026-06-03T00:00:00.000Z"),
      }),
    ).resolves.toEqual([]);
  });

  it("preserves UTF-16 surrogate pairs when summarizing long pages", async () => {
    // 496 ASCII chars + "🔥" (2 units) = 498 total chars > 500 when repeated
    const mainText = "a".repeat(496) + "🔥".repeat(10);
    const page = {
      id: "page-surrogate",
      agentId: "agent-1",
      browser: "chrome",
      profileId: "default",
      windowId: "window-1",
      tabId: "tab-1",
      url: "https://example.com/article",
      title: "Article",
      selectionText: null,
      mainText,
      headings: [],
      links: [],
      forms: [],
      capturedAt: "2026-06-02T12:00:00.000Z",
      metadata: {},
    };
    const routeService = {
      getCurrentBrowserPage: vi.fn(async () => page),
    };
    const runtime = {
      agentId: "agent-1",
      getService: vi.fn(() => routeService),
    } as unknown as IAgentRuntime;
    const adapter = new BrowserBridgeAdapter();

    const messages = await adapter.listMessages(runtime, { limit: 1 });
    expect(messages[0]?.snippet).toBeDefined();
    // 496 "a"s + "..." = 499 total chars, without a broken surrogate
    expect(messages[0]?.snippet).toBe(`${"a".repeat(496)}...`);
  });
});
