import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
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
  await openAppPath(page, "/apps/plugins");
  await expect(page.getByTestId("connectors-settings-content")).toBeVisible({
    timeout: 30_000,
  });
}

async function expandConnector(page: Page, connectorId: string): Promise<void> {
  const section = page.getByTestId(`connector-section-${connectorId}`);
  await section.scrollIntoViewIfNeeded();
  await section.getByTestId(`connector-card-${connectorId}`).click();
  await expect(
    section.getByTestId(`connector-mode-${connectorId}-bot`).first(),
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("connector modes keep developer credentials as the default path", async ({
  page,
}) => {
  await installConnectorRoutes(page, { cloudConnected: false });
  await openConnectors(page);

  await expandConnector(page, "telegram");
  const telegramSection = page.getByTestId("connector-section-telegram");
  await expect(
    telegramSection.getByTestId("connector-mode-telegram-plugin-managed"),
  ).toHaveClass(/border-accent/);
  await expect(
    telegramSection.getByText(
      "Manage Telegram bot accounts through @elizaos/plugin-telegram account inventory.",
    ),
  ).toBeVisible();

  await telegramSection.getByTestId("connector-mode-telegram-bot").click();
  await expect(
    telegramSection.getByText("Connect a Telegram Bot"),
  ).toBeVisible();

  await telegramSection.getByTestId("connector-mode-telegram-account").click();
  await expect(
    telegramSection.getByText("Connect your Telegram account"),
  ).toBeVisible();

  await expandConnector(page, "discord");
  const discordSection = page.getByTestId("connector-section-discord");
  await expect(
    discordSection.getByTestId("connector-mode-discord-bot"),
  ).toHaveClass(/border-accent/);
  await expect(
    discordSection.getByTestId("connector-mode-discord-managed"),
  ).toHaveCount(0);
  await expect(
    discordSection.getByText(
      /Prefer OAuth\? Connect Eliza Cloud to use the shared (?:Eliza )?Discord gateway instead of a local bot token\./,
    ),
  ).toBeVisible();

  await discordSection.getByTestId("connector-mode-discord-local").click();
  await expect(
    discordSection.getByRole("button", { name: "Authorize Discord desktop" }),
  ).toBeVisible();
});

test("Cloud-connected Discord exposes the managed gateway only when selected", async ({
  page,
}) => {
  await installConnectorRoutes(page, { cloudConnected: true });
  await openConnectors(page);

  await expandConnector(page, "discord");
  const discordSection = page.getByTestId("connector-section-discord");
  await expect(
    discordSection.getByTestId("connector-mode-discord-bot"),
  ).toHaveClass(/border-accent/);
  await expect(
    discordSection.getByTestId("connector-mode-discord-managed"),
  ).toBeVisible();
  await expect(
    discordSection.getByText(
      /Prefer OAuth\? Managed Discord uses a shared (?:Eliza )?gateway and only works for servers owned by the linking Discord account\./,
    ),
  ).toHaveCount(0);

  await discordSection.getByTestId("connector-mode-discord-managed").click();
  await expect(
    discordSection.getByText(
      /Prefer OAuth\? Managed Discord uses a shared (?:Eliza )?gateway and only works for servers owned by the linking Discord account\./,
    ),
  ).toBeVisible();
  await expect(
    discordSection.getByRole("button", { name: "Use managed Discord" }),
  ).toBeVisible();
});
