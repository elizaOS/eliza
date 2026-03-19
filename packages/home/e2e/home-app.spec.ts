import { expect, test, type Page } from "@playwright/test";
import { installHomeMocks } from "./home-mocks";

const routeCases: Array<{
  name: string;
  path: string;
  assertVisible: (page: Page) => Promise<void>;
}> = [
  {
    name: "chat",
    path: "/chat",
    assertVisible: async (page) => {
      await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();
    },
  },
  {
    name: "stream",
    path: "/stream",
    assertVisible: async (page) => {
      await expect(page.locator("[data-stream-view]")).toBeVisible();
      await expect(page.getByText("OFFLINE")).toBeVisible();
    },
  },
  {
    name: "character select",
    path: "/character-select",
    assertVisible: async (page) => {
      // character-select loads the CharacterView with the preset roster.
      // In native shell mode the app may redirect to chat; verify either
      // the roster grid or the chat composer is visible.
      await expect(
        page.getByTestId("character-roster-grid").or(
          page.getByTestId("chat-composer-textarea"),
        ),
      ).toBeVisible({ timeout: 10_000 });
    },
  },
  {
    name: "character notebook",
    path: "/character",
    assertVisible: async (page) => {
      await expect(page.getByTestId("character-notebook")).toBeVisible();
    },
  },
  {
    name: "wallets",
    path: "/wallets",
    assertVisible: async (page) => {
      await expect(page.getByTestId("wallet-balance-value")).toBeVisible();
    },
  },
  {
    name: "knowledge",
    path: "/knowledge",
    assertVisible: async (page) => {
      await expect(
        page.getByLabel("Knowledge upload controls"),
      ).toBeVisible();
    },
  },
  {
    name: "connectors",
    path: "/connectors",
    assertVisible: async (page) => {
      await expect(page.getByTestId("plugins-view-social")).toBeVisible();
      await expect(
        page.getByTestId("connector-header-telegram-connector").first(),
      ).toBeVisible();
    },
  },
  {
    name: "heartbeats",
    path: "/triggers",
    assertVisible: async (page) => {
      await expect(page.getByText("Morning Check-In")).toBeVisible();
    },
  },
  {
    name: "settings",
    path: "/settings",
    assertVisible: async (page) => {
      await expect(page.getByPlaceholder("Search settings...")).toBeVisible();
    },
  },
  {
    name: "advanced shell",
    path: "/advanced",
    assertVisible: async (page) => {
      await expect(page.getByText("Telegram Connector")).toBeVisible();
    },
  },
  {
    name: "plugins",
    path: "/plugins",
    assertVisible: async (page) => {
      await expect(page.getByText("Telegram Connector")).toBeVisible();
    },
  },
  {
    name: "skills",
    path: "/skills",
    assertVisible: async (page) => {
      await expect(page.getByText("Release Checklist")).toBeVisible();
    },
  },
  {
    name: "actions",
    path: "/actions",
    assertVisible: async (page) => {
      await expect(page.getByTestId("custom-actions-view")).toBeVisible();
      await expect(page.getByText("Morning Handshake")).toBeVisible();
    },
  },
  {
    name: "fine tuning",
    path: "/fine-tuning",
    assertVisible: async (page) => {
      await expect(page.getByRole("button", { name: "Build Dataset" })).toBeVisible();
    },
  },
  {
    name: "trajectories",
    path: "/trajectories",
    assertVisible: async (page) => {
      await expect(page.getByTestId("trajectories-view")).toBeVisible();
    },
  },
  {
    name: "runtime",
    path: "/runtime",
    assertVisible: async (page) => {
      await expect(page.getByTestId("runtime-view")).toBeVisible();
      await expect(page.getByText("streaming-base")).toBeVisible();
    },
  },
  {
    name: "database",
    path: "/database",
    assertVisible: async (page) => {
      await expect(page.getByText("memories")).toBeVisible();
    },
  },
  {
    name: "logs",
    path: "/logs",
    assertVisible: async (page) => {
      await expect(page.getByTestId("log-entry")).toBeVisible();
    },
  },
  {
    name: "security",
    path: "/security",
    assertVisible: async (page) => {
      await expect(page.getByTestId("security-audit-view")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Security Audit" })).toBeVisible();
    },
  },
  {
    name: "companion fallback",
    path: "/companion",
    assertVisible: async (page) => {
      await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();
    },
  },
  {
    name: "apps fallback",
    path: "/apps",
    assertVisible: async (page) => {
      await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();
    },
  },
];

test("completes onboarding and chats end to end", async ({ page }) => {
  const monitor = await installHomeMocks(page, { onboardingComplete: false });

  await page.goto("/");

  // 1. Identity step: select a character and continue
  await expect(page.getByTestId("onboarding-preset-Noted.")).toBeVisible();
  await page.getByTestId("onboarding-preset-Noted.").click();
  await page.getByRole("button", { name: "Continue" }).click();

  // 2. Connection step: Local → Ollama → Confirm
  await page.getByRole("button", { name: "Local" }).click();
  await page.getByRole("button", { name: /Ollama/i }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  // 3. RPC step: skip
  await page.getByRole("button", { name: "Skip for now" }).click();

  // 4. Permissions step
  await expect(page.getByTestId("web-onboarding-permissions")).toBeVisible();
  await page
    .getByTestId("web-onboarding-permissions")
    .getByRole("button", { name: "Continue" })
    .click();

  // 5. Activate step
  await page.getByRole("button", { name: "Enter" }).click();

  // After onboarding, the app lands on the chat view
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeVisible();
  await composer.fill("Run the morning status check.");
  await page.getByTestId("chat-composer-action").click();

  await expect(
    page.getByText("Run the morning status check.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Acknowledged: Run the morning status check.", {
      exact: true,
    }),
  ).toBeVisible();

  await monitor.assertHealthy();
});

for (const routeCase of routeCases) {
  test(`renders ${routeCase.name}`, async ({ page }) => {
    const monitor = await installHomeMocks(page, { onboardingComplete: true });

    await page.goto(routeCase.path);
    await routeCase.assertVisible(page);

    await monitor.assertHealthy();
  });
}

test("opens the voice settings section", async ({ page }) => {
  const monitor = await installHomeMocks(page, { onboardingComplete: true });

  await page.goto("/settings");
  await expect(page.getByPlaceholder("Search settings...")).toBeVisible();
  // The xl: sidebar (complementary) is hidden in headless Chromium, so click
  // the Voice section header button in the main content area instead.
  await page
    .getByRole("main")
    .getByRole("button", { name: /^Voice$/ })
    .click();
  await expect(page.getByText("Wake Word", { exact: true })).toBeVisible();

  await monitor.assertHealthy();
});
