/**
 * Discord user-account scraper — moved out of `app-lifeops` so it lives next
 * to the rest of the Discord connector code. The scraper drives a real Discord
 * web app inside a per-account browser-workspace partition (one set of cookies
 * per ConnectorAccount.id) and reads delivery state, DM previews, and search
 * results back through DOM eval.
 *
 * The desktop CDP path (`discord-desktop-cdp.ts`) is the fallback when the
 * Eliza Desktop Browser workspace is unavailable but a Discord desktop client
 * with the CDP debugger is running locally.
 */

export {
  buildDiscordProbeScript,
  captureDiscordDeliveryStatus,
  closeDiscordTab,
  DISCORD_APP_URL,
  DISCORD_PROVIDER_ID,
  type DiscordDmInboxProbe,
  type DiscordMessageSearchResult,
  type DiscordTabIdentity,
  type DiscordTabProbe,
  type DiscordVisibleDmPreview,
  discordBrowserWorkspaceAvailable,
  discordUserAccountPartitionFor,
  emptyDiscordDmInboxProbe,
  ensureDiscordTab,
  navigateDiscordTabToHome,
  probeDiscordCapturedPage,
  probeDiscordDocumentState,
  probeDiscordTab,
  searchDiscordMessages,
} from "./discord-browser-scraper";
export {
  type DiscordDesktopCdpStatus,
  getDiscordDesktopCdpStatus,
  relaunchDiscordDesktopForCdp,
  sendDiscordViaDesktopCdp,
} from "./discord-desktop-cdp";
export {
  DISCORD_USER_ACCOUNT_SCRAPER_SERVICE_TYPE,
  type DiscordUserAccountScraper,
  DiscordUserAccountScraperImpl,
} from "./service";
