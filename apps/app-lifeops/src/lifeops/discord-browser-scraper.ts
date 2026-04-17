import {
  closeBrowserWorkspaceTab,
  evaluateBrowserWorkspaceTab,
  isBrowserWorkspaceBridgeConfigured,
  listBrowserWorkspaceTabs,
  navigateBrowserWorkspaceTab,
  openBrowserWorkspaceTab,
  showBrowserWorkspaceTab,
} from "@elizaos/agent/services/browser-workspace";
import type {
  LifeOpsBrowserPageContext,
  LifeOpsConnectorSide,
} from "@elizaos/shared/contracts/lifeops";

export const DISCORD_APP_URL = "https://discord.com/channels/@me";
const DISCORD_APP_TITLE = "Discord";
const DISCORD_DM_PREVIEW_LIMIT = 5;

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

function selectedDiscordDmChannelId(value: string | null | undefined): string | null {
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
    return ariaLabel
      .split(",")
      .map((part) => normalizeDiscordText(part))
      .find((part) => part !== null && !/\bunread\b/i.test(part)) ?? ariaLabel;
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

function discordAnchorSnippet(anchor: Element, label: string | null): string | null {
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
        LifeOpsBrowserPageContext,
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

  const formFields = (page.forms ?? []).flatMap((form) => form.fields ?? []);
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
      rawSnippet: normalizeDiscordText(page.mainText ?? null)?.slice(0, 160) ?? null,
    };
  }

  const selectedChannelId = selectedDiscordDmChannelId(safeUrl);
  const previews: DiscordVisibleDmPreview[] = [];
  const seen = new Set<string>();
  for (const candidate of page.links ?? []) {
    if (!isDiscordUrl(candidate.href)) continue;
    const href = normalizeDiscordText(candidate.href);
    if (!href || !href.includes("/channels/@me/")) continue;
    const channelId = selectedDiscordDmChannelId(href);
    const dedupeKey = channelId ?? href;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    previews.push({
      channelId,
      href,
      label: normalizeDiscordText(candidate.text) ?? channelId ?? "Direct message",
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
    rawSnippet: normalizeDiscordText(page.mainText ?? null)?.slice(0, 160) ?? null,
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
    const discriminator = normalizeDiscordText(tagEl?.textContent ?? null)?.replace(
      /^#/,
      "",
    ) ?? null;
    const snippet = normalizeDiscordText(panel?.textContent ?? null)?.slice(
      0,
      160,
    ) ?? null;
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

function buildDiscordProbeScript(): string {
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

export function discordPartitionFor(
  agentId: string,
  side: LifeOpsConnectorSide,
): string {
  return `lifeops-discord-${agentId}-${side}`;
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
      tab.url.includes("discord.com"),
  );
  if (byPartition) return { id: byPartition.id, url: byPartition.url };
  return null;
}

export async function ensureDiscordTab(args: {
  agentId: string;
  side: LifeOpsConnectorSide;
  existingTabId?: string | null;
  show?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ tabId: string; url: string }> {
  const env = args.env ?? process.env;
  if (!discordBrowserWorkspaceAvailable(env)) {
    throw new Error(
      "Discord connector requires the Milady desktop app's browser workspace.",
    );
  }

  const partition = discordPartitionFor(args.agentId, args.side);
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
