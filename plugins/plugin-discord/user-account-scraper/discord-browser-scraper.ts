// Discord user-account scraper. Drives a logged-in Discord web app inside the
// Eliza browser workspace, scoped to a per-account partition. The bot-token
// path (discord.js) is for agent-owned messaging; this scraper exists for
// owner-side inspection of a real user's Discord (DM previews, search,
// delivery status) when a bot can't reach that scope.
import {
  closeBrowserWorkspaceTab,
  evaluateBrowserWorkspaceTab,
  isBrowserWorkspaceBridgeConfigured,
  listBrowserWorkspaceTabs,
  navigateBrowserWorkspaceTab,
  openBrowserWorkspaceTab,
  resolveBrowserWorkspaceConnectorPartition,
  showBrowserWorkspaceTab,
} from "@elizaos/plugin-browser/workspace";
import type { BrowserBridgePageContext } from "@elizaos/plugin-browser";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../accounts";

export const DISCORD_PROVIDER_ID = "discord";

export const DISCORD_APP_URL = "https://discord.com/channels/@me";
const DISCORD_APP_TITLE = "Discord";
const DISCORD_DM_PREVIEW_LIMIT = 5;

function isDiscordHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "discord.com" || u.hostname.endsWith(".discord.com");
  } catch {
    return false;
  }
}

export interface DiscordTabIdentity {
  id: string | null;
  username: string | null;
  discriminator: string | null;
}

export interface DiscordVisibleDmPreview {
  channelId: string | null;
  href: string | null;
  label: string;
  selected: boolean;
  unread: boolean;
  snippet: string | null;
}

export interface DiscordDmInboxProbe {
  visible: boolean;
  count: number;
  selectedChannelId: string | null;
  previews: DiscordVisibleDmPreview[];
}

export interface DiscordTabProbe {
  loggedIn: boolean;
  url: string | null;
  identity: DiscordTabIdentity;
  rawSnippet: string | null;
  dmInbox: DiscordDmInboxProbe;
}

function normalizeDiscordText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function isDiscordUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value, "https://discord.com");
    return /(^|\.)discord\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function selectedDiscordDmChannelId(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeDiscordText(value);
  if (!normalized) return null;
  const match = normalized.match(/\/channels\/@me\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function isDiscordLoginPage(args: {
  url: string | null;
  title?: string | null;
  mainText?: string | null;
  formFields?: string[];
}): boolean {
  const url = normalizeDiscordText(args.url);
  const title = normalizeDiscordText(args.title);
  const mainText = normalizeDiscordText(args.mainText);
  const formFields = (args.formFields ?? [])
    .map((field) => normalizeDiscordText(field))
    .filter((field): field is string => field !== null)
    .join(" ");

  if (url?.includes("/login") || url?.includes("/register")) {
    return true;
  }

  const combined = [title, mainText, formFields]
    .filter((value): value is string => value !== null)
    .join(" ");
  return /\b(log ?in|sign ?in|register)\b/i.test(combined) &&
    /\bdiscord\b/i.test(combined)
    ? true
    : /\b(email|password)\b/i.test(formFields);
}

function discordAnchorTextParts(anchor: Element): string[] {
  const values = new Set<string>();

  const push = (value: string | null) => {
    if (!value) return;
    if (/^\d+$/.test(value)) return;
    values.add(value);
  };

  for (const node of anchor.querySelectorAll("span, div")) {
    push(normalizeDiscordText(node.textContent));
  }

  push(normalizeDiscordText(anchor.getAttribute("aria-label")));
  if (values.size === 0) {
    push(normalizeDiscordText(anchor.textContent));
  }

  return [...values];
}

function discordAnchorLabel(anchor: Element): string | null {
  const ariaLabel = normalizeDiscordText(anchor.getAttribute("aria-label"));
  if (ariaLabel) {
    return (
      ariaLabel
        .split(",")
        .map((part) => normalizeDiscordText(part))
        .find((part) => part !== null && !/\bunread\b/i.test(part)) ?? ariaLabel
    );
  }

  const parts = discordAnchorTextParts(anchor);
  return (
    parts.find(
      (part) =>
        !/\bunread\b/i.test(part) &&
        !/^(active now|voice connected|mutual friends?)$/i.test(part),
    ) ?? null
  );
}

function discordAnchorSnippet(
  anchor: Element,
  label: string | null,
): string | null {
  const parts = discordAnchorTextParts(anchor);
  return (
    parts.find(
      (part) =>
        part !== label &&
        !/\bunread\b/i.test(part) &&
        !/^(active now|voice connected|mutual friends?)$/i.test(part),
    ) ?? null
  );
}

function extractDiscordDmPreviews(
  document: Document,
  selectedChannelId: string | null,
): DiscordVisibleDmPreview[] {
  const previews: DiscordVisibleDmPreview[] = [];
  const seen = new Set<string>();

  for (const anchor of document.querySelectorAll('a[href^="/channels/@me/"]')) {
    const href = normalizeDiscordText(anchor.getAttribute("href"));
    if (!href || href === "/channels/@me") continue;

    const channelId = selectedDiscordDmChannelId(href);
    const dedupeKey = channelId ?? href;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const label = discordAnchorLabel(anchor) ?? channelId ?? "Direct message";
    const unreadSignal = [
      normalizeDiscordText(anchor.getAttribute("aria-label")),
      normalizeDiscordText(anchor.textContent),
    ]
      .filter((value): value is string => value !== null)
      .join(" ");

    previews.push({
      channelId,
      href,
      label,
      selected:
        (channelId !== null && channelId === selectedChannelId) ||
        anchor.getAttribute("aria-current") === "page" ||
        anchor.getAttribute("aria-selected") === "true",
      unread:
        /\bunread\b|\bnew messages?\b/i.test(unreadSignal) ||
        Boolean(
          anchor.querySelector('[aria-label*="unread" i], [class*="unread"]'),
        ),
      snippet: discordAnchorSnippet(anchor, label),
    });
  }

  return previews;
}

export function emptyDiscordDmInboxProbe(): DiscordDmInboxProbe {
  return {
    visible: false,
    count: 0,
    selectedChannelId: null,
    previews: [],
  };
}

function emptyDiscordTabProbe(url: string | null = null): DiscordTabProbe {
  return {
    loggedIn: false,
    url,
    identity: {
      id: null,
      username: null,
      discriminator: null,
    },
    rawSnippet: null,
    dmInbox: emptyDiscordDmInboxProbe(),
  };
}

export function probeDiscordCapturedPage(
  page:
    | Pick<
        BrowserBridgePageContext,
        "url" | "title" | "mainText" | "links" | "forms"
      >
    | {
        url: string | null;
        title?: string | null;
        mainText?: string | null;
        links?: Array<{ text: string; href: string }>;
        forms?: Array<{ action: string | null; fields: string[] }>;
      },
): DiscordTabProbe {
  const safeUrl = normalizeDiscordText(page.url);
  if (!safeUrl || !isDiscordUrl(safeUrl)) {
    return emptyDiscordTabProbe(safeUrl ?? null);
  }

  const forms: Array<{ action: string | null; fields: string[] }> =
    page.forms ?? [];
  const formFields = forms.flatMap((form) => form.fields);
  if (
    isDiscordLoginPage({
      url: safeUrl,
      title: page.title ?? null,
      mainText: page.mainText ?? null,
      formFields,
    })
  ) {
    return {
      ...emptyDiscordTabProbe(safeUrl),
      rawSnippet:
        normalizeDiscordText(page.mainText ?? null)?.slice(0, 160) ?? null,
    };
  }

  const selectedChannelId = selectedDiscordDmChannelId(safeUrl);
  const previews: DiscordVisibleDmPreview[] = [];
  const seen = new Set<string>();
  for (const candidate of page.links ?? []) {
    if (!isDiscordUrl(candidate.href)) continue;
    const href = normalizeDiscordText(candidate.href);
    if (!href?.includes("/channels/@me/")) continue;
    const channelId = selectedDiscordDmChannelId(href);
    const dedupeKey = channelId ?? href;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    previews.push({
      channelId,
      href,
      label:
        normalizeDiscordText(candidate.text) ?? channelId ?? "Direct message",
      selected: channelId !== null && channelId === selectedChannelId,
      unread: false,
      snippet: null,
    });
  }

  return {
    loggedIn: true,
    url: safeUrl,
    identity: {
      id: null,
      username: null,
      discriminator: null,
    },
    rawSnippet:
      normalizeDiscordText(page.mainText ?? null)?.slice(0, 160) ?? null,
    dmInbox: {
      visible: previews.length > 0 || safeUrl.includes("/channels/@me"),
      count: previews.length,
      selectedChannelId,
      previews: previews.slice(0, DISCORD_DM_PREVIEW_LIMIT),
    },
  };
}

export function probeDiscordDocumentState(
  document: Document,
  url: string | null,
): DiscordTabProbe {
  try {
    const safeUrl = normalizeDiscordText(url);
    const atLogin =
      (safeUrl?.includes("/login") ?? false) ||
      (safeUrl?.includes("/register") ?? false) ||
      !!document.querySelector('input[name="email"], input[type="email"]');
    if (atLogin) {
      return emptyDiscordTabProbe(safeUrl ?? null);
    }

    const guildsNav = document.querySelector('[data-list-id="guildsnav"]');
    const sidebar =
      guildsNav ||
      document.querySelector('nav[aria-label*="Servers" i]') ||
      document.querySelector('[class*="guilds-"]') ||
      document.querySelector('a[href^="/channels/@me/"]');
    if (!sidebar) {
      return emptyDiscordTabProbe(safeUrl ?? null);
    }

    const panel =
      document.querySelector('section[aria-label*="User area" i]') ||
      document.querySelector('[class*="panelTitleContainer"]') ||
      document.querySelector('[class*="nameTag"]')?.parentElement ||
      null;
    const nameEl =
      panel?.querySelector('[class*="nameTag"] [class*="name-"]') ||
      panel?.querySelector('[class*="name-"]') ||
      document.querySelector('[class*="nameTag"] [class*="name-"]') ||
      document.querySelector('[class*="nameTag"]');
    const tagEl =
      panel?.querySelector('[class*="nameTag"] [class*="discrim"]') ||
      document.querySelector('[class*="nameTag"] [class*="discrim"]');
    const username = normalizeDiscordText(nameEl?.textContent ?? null);
    const discriminator =
      normalizeDiscordText(tagEl?.textContent ?? null)?.replace(/^#/, "") ??
      null;
    const snippet =
      normalizeDiscordText(panel?.textContent ?? null)?.slice(0, 160) ?? null;
    const selectedChannelId = selectedDiscordDmChannelId(safeUrl ?? null);
    const previews = extractDiscordDmPreviews(document, selectedChannelId);

    return {
      loggedIn: true,
      url: safeUrl ?? null,
      identity: {
        id: null,
        username,
        discriminator,
      },
      rawSnippet: snippet,
      dmInbox: {
        visible: previews.length > 0 || selectedChannelId !== null,
        count: previews.length,
        selectedChannelId,
        previews: previews.slice(0, DISCORD_DM_PREVIEW_LIMIT),
      },
    };
  } catch (error) {
    return {
      ...emptyDiscordTabProbe(null),
      rawSnippet: String(error),
    };
  }
}

export function buildDiscordProbeScript(): string {
  return `(() => {
    const DISCORD_DM_PREVIEW_LIMIT = ${DISCORD_DM_PREVIEW_LIMIT};
    const normalizeDiscordText = ${normalizeDiscordText.toString()};
    const selectedDiscordDmChannelId = ${selectedDiscordDmChannelId.toString()};
    const discordAnchorTextParts = ${discordAnchorTextParts.toString()};
    const discordAnchorLabel = ${discordAnchorLabel.toString()};
    const discordAnchorSnippet = ${discordAnchorSnippet.toString()};
    const extractDiscordDmPreviews = ${extractDiscordDmPreviews.toString()};
    const emptyDiscordDmInboxProbe = ${emptyDiscordDmInboxProbe.toString()};
    const emptyDiscordTabProbe = ${emptyDiscordTabProbe.toString()};
    const probeDiscordDocumentState = ${probeDiscordDocumentState.toString()};
    return probeDiscordDocumentState(document, window.location.href || null);
  })();`;
}

export function discordBrowserWorkspaceAvailable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isBrowserWorkspaceBridgeConfigured(env);
}

/**
 * Resolve the browser-workspace partition for a Discord user-account scrape
 * session. Each user account gets its own partition so cookies are not shared
 * across accounts. Single-account env-only deployments use DEFAULT_ACCOUNT_ID.
 */
export function discordUserAccountPartitionFor(accountId?: string): string {
  return resolveBrowserWorkspaceConnectorPartition(
    DISCORD_PROVIDER_ID,
    normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID),
  );
}

async function findTabByIdOrPartition(
  tabId: string | null,
  partition: string,
  env: NodeJS.ProcessEnv,
): Promise<{ id: string; url: string } | null> {
  const tabs = await listBrowserWorkspaceTabs(env);
  if (tabId) {
    const hit = tabs.find((tab) => tab.id === tabId);
    if (hit) return { id: hit.id, url: hit.url };
  }
  const byPartition = tabs.find(
    (tab) =>
      tab.partition === partition &&
      typeof tab.url === "string" &&
      isDiscordHost(tab.url),
  );
  if (byPartition) return { id: byPartition.id, url: byPartition.url };
  return null;
}

export async function ensureDiscordTab(args: {
  /**
   * Connector account ID. The browser partition is keyed off this so cookies
   * stay isolated across multiple Discord user accounts. Defaults to
   * DEFAULT_ACCOUNT_ID when omitted.
   */
  accountId?: string;
  existingTabId?: string | null;
  show?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ tabId: string; url: string }> {
  const env = args.env ?? process.env;
  if (!discordBrowserWorkspaceAvailable(env)) {
    throw new Error(
      "Discord connector requires the Eliza Desktop Browser workspace.",
    );
  }

  const partition = discordUserAccountPartitionFor(args.accountId);
  const existing = await findTabByIdOrPartition(
    args.existingTabId ?? null,
    partition,
    env,
  );

  if (existing) {
    if (args.show) {
      await showBrowserWorkspaceTab(existing.id, env);
    }
    return { tabId: existing.id, url: existing.url };
  }

  const tab = await openBrowserWorkspaceTab(
    {
      url: DISCORD_APP_URL,
      partition,
      kind: "internal",
      title: DISCORD_APP_TITLE,
      show: args.show ?? true,
    },
    env,
  );
  return { tabId: tab.id, url: tab.url };
}

export async function navigateDiscordTabToHome(
  tabId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await navigateBrowserWorkspaceTab({ id: tabId, url: DISCORD_APP_URL }, env);
}

export async function closeDiscordTab(
  tabId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await closeBrowserWorkspaceTab(tabId, env);
}

/**
 * Evaluate a probe inside the Discord tab to determine login state and
 * extract the current user. Returns `loggedIn: false` when the tab is on
 * the login screen, when the tab has not finished loading the app shell,
 * or when the selectors fail — never throws.
 */
export async function probeDiscordTab(
  tabId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscordTabProbe> {
  const result = (await evaluateBrowserWorkspaceTab(
    { id: tabId, script: buildDiscordProbeScript() },
    env,
  )) as DiscordTabProbe | null | undefined;

  if (!result || typeof result !== "object") {
    return emptyDiscordTabProbe(null);
  }
  return {
    ...emptyDiscordTabProbe(null),
    ...result,
    identity: {
      ...emptyDiscordTabProbe(null).identity,
      ...(result.identity ?? {}),
    },
    dmInbox: result.dmInbox ?? emptyDiscordDmInboxProbe(),
  };
}

// ---------------------------------------------------------------------------
// Message search via browser-DOM eval
// ---------------------------------------------------------------------------

export interface DiscordMessageSearchResult {
  id: string | null;
  content: string;
  authorName: string | null;
  guildId: string | null;
  channelId: string | null;
  timestamp: string | null;
  /** Delivery status indicator derived from DOM state (partial). */
  deliveryStatus: "sent" | "sending" | "failed" | "unknown";
}

function normalizeDiscordDeliveryStatus(
  value: unknown,
): DiscordMessageSearchResult["deliveryStatus"] | null {
  return value === "sent" ||
    value === "sending" ||
    value === "failed" ||
    value === "unknown"
    ? value
    : null;
}

function normalizeDiscordResultText(value: unknown): string | null {
  return typeof value === "string" ? normalizeDiscordText(value) : null;
}

function normalizeDiscordMessageSearchResults(
  value: unknown,
  operation: string,
): DiscordMessageSearchResult[] {
  if (!Array.isArray(value)) {
    throw new Error(`Discord ${operation} returned an invalid result.`);
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Discord ${operation} result ${index} is invalid.`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.content !== "string") {
      throw new Error(
        `Discord ${operation} result ${index} is missing content.`,
      );
    }
    const deliveryStatus = normalizeDiscordDeliveryStatus(
      record.deliveryStatus,
    );
    if (!deliveryStatus) {
      throw new Error(
        `Discord ${operation} result ${index} has invalid delivery status.`,
      );
    }
    return {
      id: normalizeDiscordResultText(record.id),
      content: record.content,
      authorName: normalizeDiscordResultText(record.authorName),
      guildId: normalizeDiscordResultText(record.guildId),
      channelId: normalizeDiscordResultText(record.channelId),
      timestamp: normalizeDiscordResultText(record.timestamp),
      deliveryStatus,
    };
  });
}

function buildDiscordSearchResultsScript(): string {
  return `(() => {
    const results = [];
    const routeMatch = window.location.href.match(/\\/channels\\/([^/?#]+)\\/([^/?#]+)/);
    const guildId = routeMatch && routeMatch[1] !== "@me" ? routeMatch[1] : null;
    const channelId = routeMatch ? routeMatch[2] : null;
    const containers = Array.from(
      document.querySelectorAll(
        '[class*="searchResultMessage"], [class*="search-result-message"]'
      )
    );
    for (const container of containers) {
      const contentEl =
        container.querySelector('[id^="message-content-"]') ||
        container.querySelector('[class*="messageContent"]');
      const content = contentEl ? (contentEl.textContent || "").trim() : "";

      const authorEl =
        container.querySelector('[class*="username-"]') ||
        container.querySelector('[class*="author-"]');
      const authorName = authorEl ? (authorEl.textContent || "").trim() : null;

      const msgEl = container.closest('[data-list-item-id]') ||
        container.querySelector('[id^="chat-messages-"]');
      const rawId = msgEl
        ? (msgEl.getAttribute('data-list-item-id') || msgEl.id || "")
        : "";
      const idMatch = rawId.match(/\\d{17,19}/);
      const id = idMatch ? idMatch[0] : null;

      const timestampEl = container.querySelector('time[datetime]');
      const timestamp = timestampEl
        ? timestampEl.getAttribute('datetime')
        : null;

      results.push({ id, content, authorName, guildId, channelId, timestamp, deliveryStatus: "unknown" });
    }
    return results;
  })();`;
}

/**
 * Trigger Discord's native in-app search using the keyboard shortcut, wait
 * for results to render, then scrape them via DOM eval.
 *
 * The search uses Discord's own full-text index — no client-side filtering.
 * Results are scoped to the currently open DM or channel when a `channelId`
 * scope is provided (by navigating to that channel first), or global when
 * no scope is given.
 *
 * Because this relies on the browser workspace eval bridge, it requires a
 * live Discord tab (`tabId`).
 */
export async function searchDiscordMessages(args: {
  tabId: string;
  query: string;
  channelId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DiscordMessageSearchResult[]> {
  const env = args.env ?? process.env;
  const query = args.query.trim();
  if (query.length === 0) {
    throw new Error("Discord search query must not be empty.");
  }

  if (args.channelId) {
    const channelUrl = `https://discord.com/channels/@me/${args.channelId}`;
    await navigateBrowserWorkspaceTab({ id: args.tabId, url: channelUrl }, env);
    // Allow the navigation to settle before searching.
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  // Build a script that uses the Discord search bar (Ctrl+K / Ctrl+F) via
  // the internal store — the Discord web app exposes a Flux-like dispatcher
  // that can be reached via `webpackChunkdiscord_app`.
  const searchScript = `(() => {
    const query = ${JSON.stringify(query)};
    try {
      // Walk webpack chunk to find the search action dispatcher.
      const chunks = window.webpackChunkdiscord_app;
      if (!chunks) return { injected: false };
      let SearchActions;
      for (const [, factories] of chunks) {
        for (const factory of Object.values(factories)) {
          try {
            const mod = {};
            factory({}, mod, { c: {}, d: (m, e) => { Object.assign(m, e); }, n: (m) => () => m });
            if (mod.searchMessages) { SearchActions = mod; break; }
          } catch { /* non-factory */ }
        }
        if (SearchActions) break;
      }
      if (!SearchActions?.searchMessages) return { injected: false };
      SearchActions.searchMessages({ query });
      return { injected: true };
    } catch(e) {
      return { injected: false, error: String(e) };
    }
  })();`;

  const injected = await evaluateBrowserWorkspaceTab(
    { id: args.tabId, script: searchScript },
    env,
  );
  if (
    !injected ||
    typeof injected !== "object" ||
    (injected as { injected?: unknown }).injected !== true
  ) {
    const error =
      typeof (injected as { error?: unknown } | null)?.error === "string"
        ? ` ${(injected as { error: string }).error}`
        : "";
    throw new Error(`Discord search injection failed.${error}`);
  }

  // Wait for Discord's search results panel to render.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const raw = (await evaluateBrowserWorkspaceTab(
    { id: args.tabId, script: buildDiscordSearchResultsScript() },
    env,
  )) as DiscordMessageSearchResult[] | null | undefined;

  return normalizeDiscordMessageSearchResults(raw, "search");
}

// ---------------------------------------------------------------------------
// Delivery status capture via DOM eval
// ---------------------------------------------------------------------------

/**
 * Read the delivery status of recently sent messages visible in the currently
 * open Discord channel. Discord renders delivery indicators in the DOM:
 * - No indicator: delivered (server acknowledged).
 * - `[class*="sending"]`: sending in progress.
 * - `[class*="failed"]` / `[aria-label*="failed" i]`: send failed.
 *
 * This is inherently partial — only messages currently rendered in the
 * viewport can be inspected.
 */
export async function captureDiscordDeliveryStatus(args: {
  tabId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DiscordMessageSearchResult[]> {
  const env = args.env ?? process.env;
  const script = `(() => {
    const results = [];
    const routeMatch = window.location.href.match(/\\/channels\\/([^/?#]+)\\/([^/?#]+)/);
    const guildId = routeMatch && routeMatch[1] !== "@me" ? routeMatch[1] : null;
    const channelId = routeMatch ? routeMatch[2] : null;
    const messages = Array.from(
      document.querySelectorAll('[class*="message-"] [id^="message-content-"], [id^="chat-messages-"] li')
    );
    for (const el of messages) {
      const contentEl = el.querySelector
        ? el.querySelector('[id^="message-content-"]') || el
        : el;
      const content = (contentEl.textContent || "").trim();

      const rawId = (el.getAttribute('data-list-item-id') || el.id || "");
      const idMatch = rawId.match(/\\d{17,19}/);
      const id = idMatch ? idMatch[0] : null;

      const timestampEl = el.querySelector('time[datetime]');
      const timestamp = timestampEl ? timestampEl.getAttribute('datetime') : null;

      const isSending = !!el.querySelector('[class*="sending"]');
      const isFailed = !!el.querySelector('[class*="failed"]') ||
        !!el.querySelector('[aria-label*="failed" i]');
      const deliveryStatus = isFailed ? 'failed' : isSending ? 'sending' : 'sent';

      results.push({ id, content, authorName: null, guildId, channelId, timestamp, deliveryStatus });
    }
    return results;
  })();`;

  const raw = (await evaluateBrowserWorkspaceTab(
    { id: args.tabId, script },
    env,
  )) as DiscordMessageSearchResult[] | null | undefined;

  return normalizeDiscordMessageSearchResults(raw, "delivery status capture");
}
