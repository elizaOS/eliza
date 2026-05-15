export const DISCORD_APP_URL = "https://discord.com/app";

export function emptyDiscordDmInboxProbe() {
  return {
    visible: false,
    count: 0,
    selectedChannelId: null,
    previews: [],
  };
}

function emptyDiscordTabProbe(url: string | null = null) {
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

export function discordBrowserWorkspaceAvailable(): boolean {
  return false;
}

export async function ensureDiscordTab(): Promise<{
  tabId: string;
  url: string;
}> {
  return { tabId: "discord-test-tab", url: DISCORD_APP_URL };
}

export async function closeDiscordTab(): Promise<void> {}

export async function probeDiscordTab() {
  return emptyDiscordTabProbe(DISCORD_APP_URL);
}

export function probeDiscordCapturedPage(page?: { url?: string | null }) {
  return emptyDiscordTabProbe(page?.url ?? DISCORD_APP_URL);
}

export async function getDiscordDesktopCdpStatus() {
  return {
    available: false,
    running: false,
    targetUrl: null,
    error: null,
  };
}

export async function relaunchDiscordDesktopForCdp() {
  return {
    ...emptyDiscordTabProbe(DISCORD_APP_URL),
    targetUrl: DISCORD_APP_URL,
  };
}

export async function searchDiscordMessages() {
  return [];
}

export async function captureDiscordDeliveryStatus() {
  return [];
}

export async function sendDiscordViaDesktopCdp() {
  return { ok: false, error: "Discord Desktop is not available in tests." };
}
