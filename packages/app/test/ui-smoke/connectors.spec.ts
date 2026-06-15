import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

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

async function openConnectors(page: Page): Promise<void> {
  await openAppPath(page, "/settings");
  await openSettingsSection(page, /^Connectors\b/);
  await expect(page.locator("#connectors")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Connectors" })).toBeVisible();
}

async function expandConnector(page: Page, connectorId: string): Promise<void> {
  const section = page.locator(`[data-connector="${connectorId}"]`);
  await expect(section).toBeVisible();
  await section.locator("summary").click();
  await expect(section).toHaveAttribute("open", "");
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("connector settings list enabled connectors and expand setup panels", async ({
  page,
}) => {
  await installConnectorRoutes(page, { cloudConnected: false });
  await openConnectors(page);

  await expect(
    page.getByRole("switch", { name: "Disable Telegram" }),
  ).toBeChecked();
  await expandConnector(page, "telegram");
  await expect(
    page.getByText(/Connect your Telegram account|Telegram/i).first(),
  ).toBeVisible();

  await expect(
    page.getByRole("switch", { name: "Disable Discord" }),
  ).toBeChecked();
  await expandConnector(page, "discord");
  await expect(
    page.getByRole("button", { name: "Authorize Discord desktop" }),
  ).toBeVisible();
});

test("cloud-connected connector settings keep local setup controls available", async ({
  page,
}) => {
  await installConnectorRoutes(page, { cloudConnected: true });
  await openConnectors(page);

  await expect(
    page.getByRole("switch", { name: "Disable Discord" }),
  ).toBeChecked();
  await expandConnector(page, "discord");
  await expect(
    page.getByRole("button", { name: "Authorize Discord desktop" }),
  ).toBeVisible();
});
