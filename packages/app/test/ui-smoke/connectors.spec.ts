/**
 * Playwright UI-smoke spec for the Connectors app flow using the real renderer
 * fixture.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
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
  // The page now has both an h1 page title and an h3 section header reading
  // "Connectors"; assert the page-title (h1) to stay unambiguous in strict mode.
  await expect(
    page.getByRole("heading", { name: "Connectors", level: 1 }),
  ).toBeVisible();
  await ensureDelegateChannelMode(page);
}

// The connectors settings surface is a list of rows that navigate to a
// per-connector detail page (#connectors/<id>); the old inline <details>
// accordion is gone. Opening a connector means clicking its row and landing
// on the detail surface.
async function openConnectorDetail(
  page: Page,
  connectorId: string,
): Promise<void> {
  const row = page.locator(`[data-connector="${connectorId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId("connector-detail")).toBeVisible();
}

async function backToConnectorList(page: Page): Promise<void> {
  // Desktop (>=md) has an inline "back to Connectors" control inside the detail
  // body and mobile has the ViewHeader icon back ("Back to Connectors").
  // NOTE: the built CSS currently orders the md: responsive utilities before
  // the base `.hidden` utility, so the desktop inline control computes
  // display:none at every width (tracked separately); when neither back
  // affordance is visible, fall back to the settings sidebar "Connectors"
  // entry, which routes back to the index the same way a user would recover.
  const candidates = [
    page.getByTestId("connector-detail-back"),
    page.getByRole("button", { name: "Back to Connectors" }),
    page.getByRole("button", { name: /^Connectors$/ }),
  ];
  for (const candidate of candidates) {
    if (await candidate.first().isVisible()) {
      await candidate.first().click();
      break;
    }
  }
  await expect(page.getByTestId("connector-detail")).toHaveCount(0);
}

async function ensureDelegateChannelMode(page: Page): Promise<void> {
  const delegateLens = page.getByTestId("connector-channel-mode-delegate");
  await expect(delegateLens).toBeVisible({ timeout: 15_000 });
  await delegateLens.click();
}

async function selectDiscordDesktopModeIfOffered(
  discordDetail: Locator,
): Promise<void> {
  // Prefer the stable mode test id over the translated label so a late i18n
  // catalog cannot skip the Desktop App path and leave Bot Token selected.
  const desktopModeButton = discordDetail.getByTestId(
    "connector-mode-discord-local",
  );
  const authorizeButton = discordDetail.getByRole("button", {
    name: /Authorize Discord desktop|pluginsview\.DiscordLocalAuthorize/i,
  });
  await desktopModeButton.or(authorizeButton).first().waitFor({
    timeout: 15_000,
  });
  if (await desktopModeButton.isVisible()) {
    await desktopModeButton.click();
  }
}

async function expectDiscordDesktopAuthorize(
  discordDetail: Locator,
): Promise<void> {
  await expect(
    discordDetail.getByRole("button", {
      name: /Authorize Discord desktop|pluginsview\.DiscordLocalAuthorize/i,
    }),
  ).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, { "eliza:connectors:channelMode": "delegate" });
  await installDefaultAppRoutes(page);
});

test("connector settings list enabled connectors and expand setup panels", async ({
  page,
}) => {
  await installConnectorRoutes(page, { cloudConnected: false });
  await openConnectors(page);

  await openConnectorDetail(page, "telegram");
  const telegramDetail = page.getByTestId("connector-detail");
  await expect(
    telegramDetail.getByText(/Connect your Telegram account|Telegram/i).first(),
  ).toBeVisible();

  await backToConnectorList(page);
  await openConnectorDetail(page, "discord");
  const discordDetail = page.getByTestId("connector-detail");
  // In the default Delegate lens Discord has a single applicable mode
  // (Desktop App), so the mode selector is omitted and the desktop-IPC setup
  // panel renders directly; click the mode button only when a selector exists.
  await selectDiscordDesktopModeIfOffered(discordDetail);
  await expectDiscordDesktopAuthorize(discordDetail);
});

test("cloud-connected connector settings keep local setup controls available", async ({
  page,
}) => {
  await installConnectorRoutes(page, { cloudConnected: true });
  await openConnectors(page);

  await openConnectorDetail(page, "discord");
  const discordDetail = page.getByTestId("connector-detail");
  await selectDiscordDesktopModeIfOffered(discordDetail);
  await expectDiscordDesktopAuthorize(discordDetail);
});
