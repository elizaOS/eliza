import {
  closeBrowserWorkspaceTab,
  evaluateBrowserWorkspaceTab,
  isBrowserWorkspaceBridgeConfigured,
  listBrowserWorkspaceTabs,
  navigateBrowserWorkspaceTab,
  openBrowserWorkspaceTab,
  showBrowserWorkspaceTab,
} from "@elizaos/agent/services/browser-workspace";
import type { LifeOpsConnectorSide } from "@elizaos/shared/contracts/lifeops";

const DISCORD_APP_URL = "https://discord.com/channels/@me";
const DISCORD_APP_TITLE = "Discord";

export interface DiscordTabIdentity {
  id: string | null;
  username: string | null;
  discriminator: string | null;
}

export interface DiscordTabProbe {
  loggedIn: boolean;
  url: string | null;
  identity: DiscordTabIdentity;
  rawSnippet: string | null;
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
  const script = `(() => {
    try {
      const url = window.location.href || "";
      const atLogin =
        url.includes("/login") ||
        url.includes("/register") ||
        !!document.querySelector('input[name="email"], input[type="email"]');
      if (atLogin) {
        return { loggedIn: false, url, identity: { id: null, username: null, discriminator: null }, rawSnippet: null };
      }
      const guildsNav = document.querySelector('[data-list-id="guildsnav"]');
      const sidebar =
        guildsNav ||
        document.querySelector('nav[aria-label*="Servers" i]') ||
        document.querySelector('[class*="guilds-"]');
      if (!sidebar) {
        return { loggedIn: false, url, identity: { id: null, username: null, discriminator: null }, rawSnippet: null };
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
      const username = nameEl && nameEl.textContent ? nameEl.textContent.trim() : null;
      const discriminator = tagEl && tagEl.textContent ? tagEl.textContent.trim().replace(/^#/, "") : null;
      const snippet = panel?.textContent?.slice(0, 160) ?? null;
      return {
        loggedIn: true,
        url,
        identity: { id: null, username, discriminator },
        rawSnippet: snippet,
      };
    } catch (err) {
      return { loggedIn: false, url: null, identity: { id: null, username: null, discriminator: null }, rawSnippet: String(err) };
    }
  })();`;

  const result = (await evaluateBrowserWorkspaceTab(
    { id: tabId, script },
    env,
  )) as DiscordTabProbe | null | undefined;

  if (!result || typeof result !== "object") {
    return {
      loggedIn: false,
      url: null,
      identity: { id: null, username: null, discriminator: null },
      rawSnippet: null,
    };
  }
  return result;
}
