import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSectionById,
  seedAppStorage,
} from "./helpers";

// Connector management now lives in Settings → Connectors (ConnectorsSection):
// one inline <details data-connector="<id>"> row per connector plugin with an
// enable/disable switch, expanding into the bespoke per-connector setup panel
// (telegram → TelegramAccountConnectorPanel, discord →
// DiscordLocalConnectorPanel). The old /apps/plugins connector accordion
// (connectors-settings-content + connector-mode-* selectors) is no longer
// mounted anywhere — /apps/plugins renders the visual plugin card grid.

type ConnectorPluginFixture = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  enabled: boolean;
  configured: boolean;
  envKey: string | null;
  category: "connector";
  source: "bundled";
  parameters: Array<{
    key: string;
    type: string;
    description: string;
    required: boolean;
    sensitive: boolean;
    currentValue: string | null;
    isSet: boolean;
  }>;
  validationErrors: Array<{ field: string; message: string }>;
  validationWarnings: Array<{ field: string; message: string }>;
  isActive: boolean;
};

const discordPlugin: ConnectorPluginFixture = {
  id: "discord",
  name: "Discord",
  description: "Connect through Discord bot tokens, desktop IPC, or Cloud.",
  tags: ["social", "discord"],
  enabled: true,
  configured: false,
  envKey: "DISCORD_API_TOKEN",
  category: "connector",
  source: "bundled",
  parameters: [
    {
      key: "DISCORD_API_TOKEN",
      type: "password",
      description: "Discord bot token",
      required: true,
      sensitive: true,
      currentValue: null,
      isSet: false,
    },
    {
      key: "DISCORD_APPLICATION_ID",
      type: "string",
      description: "Discord application ID",
      required: false,
      sensitive: false,
      currentValue: null,
      isSet: false,
    },
  ],
  validationErrors: [],
  validationWarnings: [],
  isActive: true,
};

const telegramPlugin: ConnectorPluginFixture = {
  id: "telegram",
  name: "Telegram",
  description: "Connect through a Telegram bot token or personal account.",
  tags: ["social", "telegram"],
  enabled: true,
  configured: false,
  envKey: "TELEGRAM_BOT_TOKEN",
  category: "connector",
  source: "bundled",
  parameters: [
    {
      key: "TELEGRAM_BOT_TOKEN",
      type: "password",
      description: "Telegram bot token",
      required: true,
      sensitive: true,
      currentValue: null,
      isSet: false,
    },
    {
      key: "TELEGRAM_ALLOWED_CHATS",
      type: "string",
      description: "Allowed chat IDs",
      required: false,
      sensitive: false,
      currentValue: "",
      isSet: false,
    },
  ],
  validationErrors: [],
  validationWarnings: [],
  isActive: true,
};

const telegramAccountStatus = {
  connector: "telegram-account",
  state: "idle",
  detail: {
    status: "idle",
    configured: false,
    sessionExists: false,
    serviceConnected: false,
    restartRequired: false,
    hasAppCredentials: false,
    phone: null,
    isCodeViaApp: false,
    account: null,
    error: null,
  },
};

const discordLocalStatus = {
  available: true,
  connected: false,
  authenticated: false,
  currentUser: null,
  subscribedChannelIds: [],
  configuredChannelIds: [],
  scopes: [],
  lastError: null,
  ipcPath: null,
};

async function installConnectorRoutes(
  page: Page,
  options: { cloudConnected: boolean },
): Promise<void> {
  await page.route("**/api/plugins", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plugins: [discordPlugin, telegramPlugin] }),
    });
  });

  await page.route("**/api/setup/telegram-account/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(telegramAccountStatus),
    });
  });

  await page.route("**/api/discord-local/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(discordLocalStatus),
    });
  });

  if (!options.cloudConnected) {
    return;
  }

  await page.route("**/api/cloud/status", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        connected: true,
        enabled: true,
        cloudVoiceProxyAvailable: true,
        hasApiKey: true,
        userId: "playwright-cloud-owner",
      }),
    });
  });

  await page.route("**/api/cloud/credits", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        balance: 25,
        low: false,
        critical: false,
        authRejected: false,
      }),
    });
  });
}

async function openConnectorsSettings(page: Page): Promise<void> {
  await openAppPath(page, "/settings");
  // The settings hub renders one section at a time, so the Connectors
  // section must be opened through its hub tile.
  await openSettingsSectionById(page, "connectors");
  await expect(page.locator("#connectors")).toBeVisible({
    timeout: 30_000,
  });
}

async function expandConnector(
  page: Page,
  connectorId: string,
): Promise<Locator> {
  const row = page
    .locator("#connectors")
    .locator(`[data-connector="${connectorId}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.locator("summary").click();
  return row;
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("connector setup keeps developer credentials as the default path", async ({
  page,
}) => {
  await installConnectorRoutes(page, { cloudConnected: false });
  await openConnectorsSettings(page);

  const connectors = page.locator("#connectors");
  await expect(connectors.locator('[data-connector="telegram"]')).toBeVisible();
  await expect(connectors.locator('[data-connector="discord"]')).toBeVisible();
  await expect(
    connectors.getByRole("switch", { name: "Disable Telegram" }),
  ).toBeVisible();
  await expect(
    connectors.getByRole("switch", { name: "Disable Discord" }),
  ).toBeVisible();

  // Telegram expands into the personal-account login panel: the app logs in
  // with the user's own credentials, no managed OAuth in between.
  const telegramRow = await expandConnector(page, "telegram");
  await expect(
    telegramRow.getByText("Connect your Telegram account"),
  ).toBeVisible();
  await expect(
    telegramRow.getByText(/This is separate from the Telegram bot connector/),
  ).toBeVisible();
  await expect(telegramRow.getByPlaceholder("+15551234567")).toBeVisible();

  // Discord expands into local desktop authorization — the developer path.
  const discordRow = await expandConnector(page, "discord");
  await expect(
    discordRow.getByRole("button", { name: "Authorize Discord desktop" }),
  ).toBeVisible();

  // No connection-mode selector or managed gateway is offered by default.
  await expect(connectors.getByText("Connection mode")).toHaveCount(0);
  await expect(
    connectors.getByRole("button", { name: "Use managed Discord" }),
  ).toHaveCount(0);
});

test("Cloud-connected Discord keeps the local developer path without a managed gateway", async ({
  page,
}) => {
  await installConnectorRoutes(page, { cloudConnected: true });
  await openConnectorsSettings(page);

  const connectors = page.locator("#connectors");
  const discordRow = await expandConnector(page, "discord");
  await expect(
    discordRow.getByRole("button", { name: "Authorize Discord desktop" }),
  ).toBeVisible();
  await expect(
    discordRow.getByText(/against the local Discord desktop app/),
  ).toBeVisible();

  // Connecting Eliza Cloud must not silently swap Discord onto a managed
  // gateway: the connectors surface keeps the local path and never offers
  // managed Discord OAuth.
  await expect(
    connectors.getByRole("button", { name: "Use managed Discord" }),
  ).toHaveCount(0);
  await expect(connectors.getByText(/managed Discord/i)).toHaveCount(0);
});
