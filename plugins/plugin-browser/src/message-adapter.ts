/**
 * MessageAdapter implementation backed by browser bridge page-context records.
 */

import {
  BaseMessageAdapter,
  type IAgentRuntime,
  type ListOptions,
  type MessageAdapterCapabilities,
  type MessageRef,
  type MessageSource,
} from "@elizaos/core";
import type { BrowserBridgePageContext } from "./contracts.js";
import {
  BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  type BrowserBridgeRouteService,
} from "./service.js";

function getBridgeService(
  runtime: IAgentRuntime,
): BrowserBridgeRouteService | null {
  return (
    (runtime.getService(BROWSER_BRIDGE_ROUTE_SERVICE_TYPE) as
      | BrowserBridgeRouteService
      | null
      | undefined) ?? null
  );
}

function parsedTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function browserPageMessageId(page: BrowserBridgePageContext): string {
  return [
    "browser_bridge",
    page.browser,
    page.profileId,
    page.windowId,
    page.tabId,
    page.capturedAt,
  ].join(":");
}

function summarizePage(page: BrowserBridgePageContext): string {
  const text =
    page.selectionText?.trim() ||
    page.mainText?.trim() ||
    page.title.trim() ||
    page.url;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function pageToMessageRef(page: BrowserBridgePageContext): MessageRef {
  return {
    id: browserPageMessageId(page),
    source: "browser_bridge",
    externalId: page.id,
    threadId: `${page.browser}:${page.profileId}:${page.windowId}:${page.tabId}`,
    from: {
      identifier: page.url,
      displayName: page.title || page.url,
    },
    to: [],
    subject: page.title || page.url,
    snippet: summarizePage(page),
    body: page.mainText ?? page.selectionText ?? undefined,
    receivedAtMs: parsedTime(page.capturedAt),
    hasAttachments: false,
    isRead: false,
    worldId: page.profileId,
    channelId: page.tabId,
    tags: ["browser", page.browser],
    metadata: {
      browser: page.browser,
      profileId: page.profileId,
      windowId: page.windowId,
      tabId: page.tabId,
      url: page.url,
      title: page.title,
      capturedAt: page.capturedAt,
      headings: page.headings,
      linkCount: page.links.length,
      formCount: page.forms.length,
    },
  };
}

function matchesListOptions(message: MessageRef, opts: ListOptions): boolean {
  if (opts.sinceMs && message.receivedAtMs < opts.sinceMs) return false;
  if (opts.worldIds?.length && !opts.worldIds.includes(message.worldId ?? "")) {
    return false;
  }
  if (
    opts.channelIds?.length &&
    !opts.channelIds.includes(message.channelId ?? "")
  ) {
    return false;
  }
  return true;
}

export class BrowserBridgeAdapter extends BaseMessageAdapter {
  readonly source: MessageSource = "browser_bridge";

  isAvailable(runtime: IAgentRuntime): boolean {
    return getBridgeService(runtime) !== null;
  }

  capabilities(): MessageAdapterCapabilities {
    return {
      list: true,
      search: false,
      manage: {},
      send: {},
      worlds: "single",
      channels: "implicit",
    };
  }

  protected override async listMessagesImpl(
    runtime: IAgentRuntime,
    opts: ListOptions,
  ): Promise<MessageRef[]> {
    const page = await getBridgeService(runtime)?.getCurrentBrowserPage();
    if (!page) return [];
    const message = pageToMessageRef(page);
    if (!matchesListOptions(message, opts)) return [];
    return opts.limit && opts.limit > 0
      ? [message].slice(0, opts.limit)
      : [message];
  }

  protected override async getMessageImpl(
    runtime: IAgentRuntime,
    id: string,
  ): Promise<MessageRef | null> {
    const page = await getBridgeService(runtime)?.getCurrentBrowserPage();
    if (!page) return null;
    const message = pageToMessageRef(page);
    return message.id === id || message.externalId === id ? message : null;
  }
}
