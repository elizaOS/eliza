/**
 * DiscordUserAccountScraperService
 *
 * Wraps the per-account Discord browser scraper as an Eliza Service so
 * downstream plugins (e.g. app-lifeops) can resolve it via
 * `runtime.getService('discord_user_account_scraper')` instead of importing
 * the raw module.
 */

import { type IAgentRuntime, Service } from "@elizaos/core";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../accounts";
import {
  captureDiscordDeliveryStatus,
  closeDiscordTab,
  type DiscordMessageSearchResult,
  type DiscordTabProbe,
  discordBrowserWorkspaceAvailable,
  discordUserAccountPartitionFor,
  ensureDiscordTab,
  navigateDiscordTabToHome,
  probeDiscordTab,
  searchDiscordMessages,
} from "./discord-browser-scraper";
import {
  type DiscordDesktopCdpStatus,
  getDiscordDesktopCdpStatus,
  relaunchDiscordDesktopForCdp,
  sendDiscordViaDesktopCdp,
} from "./discord-desktop-cdp";

export const DISCORD_USER_ACCOUNT_SCRAPER_SERVICE_TYPE =
  "discord_user_account_scraper";

/**
 * Public surface of the scraper. Each call carries a `accountId` so the
 * underlying browser partition is correctly scoped.
 */
export interface DiscordUserAccountScraper {
  isWorkspaceAvailable(env?: NodeJS.ProcessEnv): boolean;
  partitionFor(accountId?: string): string;
  ensureTab(args: {
    accountId?: string;
    existingTabId?: string | null;
    show?: boolean;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ tabId: string; url: string }>;
  navigateTabHome(tabId: string, env?: NodeJS.ProcessEnv): Promise<void>;
  closeTab(tabId: string, env?: NodeJS.ProcessEnv): Promise<void>;
  probeTab(tabId: string, env?: NodeJS.ProcessEnv): Promise<DiscordTabProbe>;
  searchMessages(args: {
    tabId: string;
    query: string;
    channelId?: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<DiscordMessageSearchResult[]>;
  captureDelivery(args: {
    tabId: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<DiscordMessageSearchResult[]>;
  desktopCdpStatus(): Promise<DiscordDesktopCdpStatus>;
  relaunchDesktopForCdp(): Promise<DiscordDesktopCdpStatus>;
  sendViaDesktopCdp(args: {
    channelId: string;
    text: string;
  }): Promise<{ ok: boolean; error?: string }>;
}

class DiscordUserAccountScraperImpl
  extends Service
  implements DiscordUserAccountScraper
{
  static serviceType = DISCORD_USER_ACCOUNT_SCRAPER_SERVICE_TYPE;
  capabilityDescription =
    "Drives a per-account Discord web app inside the Eliza browser workspace for DM probing, search, and delivery status capture.";

  static async start(runtime: IAgentRuntime): Promise<Service> {
    return new DiscordUserAccountScraperImpl(runtime);
  }

  async stop(): Promise<void> {}

  isWorkspaceAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
    return discordBrowserWorkspaceAvailable(env);
  }

  partitionFor(accountId?: string): string {
    return discordUserAccountPartitionFor(
      normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID),
    );
  }

  ensureTab(args: {
    accountId?: string;
    existingTabId?: string | null;
    show?: boolean;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ tabId: string; url: string }> {
    return ensureDiscordTab(args);
  }

  navigateTabHome(
    tabId: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<void> {
    return navigateDiscordTabToHome(tabId, env);
  }

  closeTab(tabId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    return closeDiscordTab(tabId, env);
  }

  probeTab(
    tabId: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<DiscordTabProbe> {
    return probeDiscordTab(tabId, env);
  }

  searchMessages(args: {
    tabId: string;
    query: string;
    channelId?: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<DiscordMessageSearchResult[]> {
    return searchDiscordMessages(args);
  }

  captureDelivery(args: {
    tabId: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<DiscordMessageSearchResult[]> {
    return captureDiscordDeliveryStatus(args);
  }

  desktopCdpStatus(): Promise<DiscordDesktopCdpStatus> {
    return getDiscordDesktopCdpStatus();
  }

  relaunchDesktopForCdp(): Promise<DiscordDesktopCdpStatus> {
    return relaunchDiscordDesktopForCdp();
  }

  sendViaDesktopCdp(args: {
    channelId: string;
    text: string;
  }): Promise<{ ok: boolean; error?: string }> {
    return sendDiscordViaDesktopCdp(args);
  }
}

export { DiscordUserAccountScraperImpl };
