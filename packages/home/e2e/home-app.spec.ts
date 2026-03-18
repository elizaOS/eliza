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
      await expect(page.getByTestId("character-roster-grid")).toBeVisible();
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
      await expect(page.getByText("Security Audit")).toBeVisible();
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

  await expect(page.getByTestId("onboarding-character-roster")).toBeVisible();
  await page.getByTestId("onboarding-preset-Noted.").click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("button", { name: "Local" }).click();
  await page.getByRole("button", { name: /Ollama/i }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByTestId("web-onboarding-permissions")).toBeVisible();
  await page
    .getByTestId("web-onboarding-permissions")
    .getByRole("button", { name: "Continue" })
    .click();

  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page.getByTestId("character-roster-grid")).toBeVisible();

  await page.getByRole("button", { name: "Native Mode" }).click();
  await expect(
    page.getByRole("button", { name: "Chat", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByText("Rin is online.")).toBeVisible();
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
  await page
    .getByRole("complementary")
    .getByRole("button", { name: /^Voice$/ })
    .click();
  await expect(page.getByText("Wake Word", { exact: true })).toBeVisible();

  await monitor.assertHealthy();
});
