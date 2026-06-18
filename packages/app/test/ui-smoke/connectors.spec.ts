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
  // The page now has both an h1 page title and an h3 section header reading
  // "Connectors"; assert the page-title (h1) to stay unambiguous in strict mode.
  await expect(
    page.getByRole("heading", { name: "Connectors", level: 1 }),
  ).toBeVisible();
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

// Real connector enable/disable round-trip against the live backend. The keyless
// stub's `GET /api/plugins` is a static fixture that never reflects a toggle, so
// the disable→reload→read-back below only converges against the real app-core
// runtime + plugin registry (ELIZA_UI_SMOKE_LIVE_STACK=1). It does NOT stub
// `PUT /api/plugins/:id` — that is the route under test. The target connector is
// discovered from the live registry (an enabled connector with a "Disable …"
// switch), so no hardcoded id is assumed, and the toggle is restored at the end.
const LIVE_STACK = process.env.ELIZA_UI_SMOKE_LIVE_STACK === "1";

test.describe("connector toggle deep round-trip", () => {
  test.skip(
    !LIVE_STACK,
    "needs the real plugin registry (ELIZA_UI_SMOKE_LIVE_STACK=1); the keyless " +
      "stub's GET /api/plugins is a static fixture that never reflects a toggle.",
  );

  test("disabling a live connector fires PUT /api/plugins/:id and flips the switch", async ({
    page,
  }) => {
    type PluginToggleRequest = { id: string; enabled: unknown };
    const toggleRequests: PluginToggleRequest[] = [];
    const pluginTogglePathRe = /\/api\/plugins\/([^/?#]+)(?:\?|$)/;
    page.on("request", (req) => {
      if (req.method() !== "PUT") return;
      const match = pluginTogglePathRe.exec(req.url());
      if (!match) return;
      const id = decodeURIComponent(match[1] ?? "");
      let body: unknown = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = null;
      }
      const enabled =
        body && typeof body === "object"
          ? (body as { enabled?: unknown }).enabled
          : undefined;
      toggleRequests.push({ id, enabled });
    });

    // No fixtures — hit the real registry.
    await openConnectors(page);

    // Pick the first connector row that is currently enabled (its switch reads
    // "Disable <name>"). aria-label exposes the toggle target unambiguously.
    const disableSwitches = page.getByRole("switch", { name: /^Disable / });
    await expect(disableSwitches.first()).toBeVisible({ timeout: 30_000 });
    const targetSwitch = disableSwitches.first();
    const disableLabel = (await targetSwitch.getAttribute("aria-label")) ?? "";
    const connectorName = disableLabel.replace(/^Disable\s+/, "").trim();
    expect(connectorName.length).toBeGreaterThan(0);

    const targetRow = page
      .locator("[data-connector]")
      .filter({ has: page.getByRole("switch", { name: disableLabel }) })
      .first();
    const connectorId = (await targetRow.getAttribute("data-connector")) ?? "";
    expect(connectorId.length).toBeGreaterThan(0);

    await targetSwitch.click();

    // Real PUT /api/plugins/<id> with {enabled:false}.
    await expect
      .poll(() => toggleRequests.filter((r) => r.id === connectorId).length)
      .toBeGreaterThan(0);
    const disableReq = toggleRequests.find(
      (r) => r.id === connectorId && r.enabled === false,
    );
    expect(
      disableReq,
      `expected PUT /api/plugins/${connectorId} with {enabled:false}`,
    ).toBeTruthy();

    // After loadPlugins() re-fetches the real registry, the switch reads
    // "Enable <name>" — the disabled state read back from the backend.
    await expect(
      page.getByRole("switch", { name: `Enable ${connectorName}` }),
    ).toBeVisible({ timeout: 30_000 });

    // Restore the connector so the run leaves no residue in the live registry.
    await page.getByRole("switch", { name: `Enable ${connectorName}` }).click();
    await expect
      .poll(
        () =>
          toggleRequests.filter(
            (r) => r.id === connectorId && r.enabled === true,
          ).length,
      )
      .toBeGreaterThan(0);
    await expect(
      page.getByRole("switch", { name: `Disable ${connectorName}` }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
