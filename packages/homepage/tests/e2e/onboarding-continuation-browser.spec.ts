/**
 * Browser-level proof for Discord and Telegram onboarding continuations.
 * The real homepage renderer drives authenticated preview, explicit
 * confirmation, platform-specific return links, responsive layout, and the
 * exact redemption request against deterministic Cloud route doubles.
 */
import { expect, type Page, test } from "playwright/test";

const SESSION = "aaaaaaaa-test-test-test-tokentoken01";
const TOKEN = "homepage-continuation-browser-token";

type Platform = "discord" | "telegram";

async function installContinuationRoutes(
  page: Page,
  platform: Platform,
  confirmedBodies: Array<Record<string, unknown>>,
): Promise<void> {
  await page.route("https://api.eliza.app/api/eliza-app/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/eliza-app/user/me") {
      await route.fulfill({
        json: {
          user: {
            id: "user-continuation-proof",
            organization_id: "org-continuation-proof",
            name: "Proof User",
          },
          organization: {
            id: "org-continuation-proof",
            name: "Proof Org",
            credit_balance: "10.00",
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/eliza-app/onboarding/chat") {
      if (request.method() === "GET") {
        await route.fulfill({
          json: {
            success: true,
            data: {
              platform,
              platformUserId:
                platform === "discord" ? "555001122334455667" : "123456789",
              platformDisplayName:
                platform === "discord" ? "shadow#0001" : "shadow_tg",
            },
          },
        });
        return;
      }
      confirmedBodies.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        json: {
          success: true,
          data: { status: "provisioning", sessionId: SESSION },
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Unhandled mock" } });
  });
}

async function installDedicatedOffRoutes(
  page: Page,
): Promise<() => Array<Record<string, unknown>>> {
  let onboardingReads = 0;
  const statusPollBodies: Array<Record<string, unknown>> = [];
  await page.route("https://api.eliza.app/api/eliza-app/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/eliza-app/user/me") {
      await route.fulfill({
        json: {
          user: {
            id: "user-dedicated-off-proof",
            organization_id: "org-dedicated-off-proof",
            name: "Proof User",
          },
          organization: {
            id: "org-dedicated-off-proof",
            name: "Proof Org",
            credit_balance: "10.00",
          },
        },
      });
      return;
    }
    if (url.pathname === "/api/eliza-app/onboarding/chat") {
      if (request.method() === "POST") {
        statusPollBodies.push(
          request.postDataJSON() as Record<string, unknown>,
        );
        await route.fulfill({
          json: {
            success: true,
            data: { provisioning: { status: "none" }, messages: [] },
          },
        });
        return;
      }
      onboardingReads += 1;
      if (onboardingReads === 1) {
        await route.fulfill({
          status: 404,
          json: { error: "Phone continuation" },
        });
        return;
      }
      await route.fulfill({
        json: {
          success: true,
          data: { provisioning: { status: "none" }, messages: [] },
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Unhandled mock" } });
  });
  return () => statusPollBodies;
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  for (const platform of ["discord", "telegram"] as const) {
    test(`${platform} continuation ${viewport.name}: preview, confirm, return`, async ({
      page,
    }, testInfo) => {
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      await page.setViewportSize(viewport);
      await page.addInitScript((token) => {
        localStorage.setItem("eliza_app_session", token as string);
      }, TOKEN);
      const confirmedBodies: Array<Record<string, unknown>> = [];
      await installContinuationRoutes(page, platform, confirmedBodies);

      await page.goto(`/get-started?onboardingSession=${SESSION}`);
      const label = platform === "discord" ? "Discord" : "Telegram";
      await expect(
        page.getByText(`Connect your ${label} account?`),
      ).toBeVisible();
      await expect(
        page.getByText(`${label} ID`, { exact: false }),
      ).toBeVisible();
      await expect(page.getByTestId("continuation-confirm-button")).toHaveCSS(
        "min-height",
        "44px",
      );
      await page.screenshot({
        path: testInfo.outputPath(`${platform}-${viewport.name}-confirm.png`),
        fullPage: true,
      });

      await page.getByTestId("continuation-confirm-button").click();
      await expect(
        page.getByText(`Head back to ${label}`, { exact: false }),
      ).toBeVisible();
      const returnLink = page.getByTestId(`continuation-open-${platform}`);
      await expect(returnLink).toBeVisible();
      await expect(returnLink).toHaveAttribute(
        "href",
        platform === "discord"
          ? "https://discord.com/channels/@me"
          : /https:\/\/t\.me\//,
      );
      expect(confirmedBodies).toEqual([
        {
          sessionId: SESSION,
          platform: "web",
          confirmPlatformLink: true,
        },
      ]);
      expect(consoleErrors).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath(`${platform}-${viewport.name}-done.png`),
        fullPage: true,
      });
    });
  }

  test(`dedicated-off continuation ${viewport.name}: observes status without provisioning`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.addInitScript((token) => {
      localStorage.setItem("eliza_app_session", token as string);
    }, TOKEN);
    const statusPollBodies = await installDedicatedOffRoutes(page);

    await page.goto(`/get-started?onboardingSession=${SESSION}`);
    await expect(page.getByText("Dedicated compute off")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue to Eliza" }),
    ).toBeVisible();
    await expect(
      page.getByPlaceholder("Dedicated is off — continue to Eliza"),
    ).toBeDisabled();
    expect(statusPollBodies().length).toBeGreaterThan(0);
    for (const body of statusPollBodies()) {
      expect(body).toEqual({
        sessionId: SESSION,
        platform: "blooio",
        statusOnly: true,
      });
    }
    await page.screenshot({
      path: testInfo.outputPath(`dedicated-off-${viewport.name}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Continue to Eliza" }).click();
    await expect(page).toHaveURL(/\/connected$/);
  });
}
