import { expect, type TestInfo, test } from "playwright/test";

const TEST_TOKEN = "telegram-return-test-token";
test.use({ viewport: { width: 390, height: 844 } });

test("redeems a bot continuation inside signed Telegram auth", async ({
  page,
}) => {
  const authBodies: unknown[] = [];
  let browserContinuationCalls = 0;

  await page.addInitScript((token) => {
    window.localStorage.setItem("eliza_app_session", token as string);
    const target = window as unknown as {
      Telegram: {
        Login: {
          auth: (
            options: { bot_id: string; request_access?: string },
            callback: (data: Record<string, unknown>) => void,
          ) => void;
        };
      };
    };
    target.Telegram = {
      Login: {
        auth: (_options, callback) =>
          callback({
            id: 123456789,
            first_name: "Sam",
            username: "sam",
            auth_date: 1_786_224_000,
            hash: "a".repeat(64),
          }),
      },
    };
  }, TEST_TOKEN);
  await page.route("https://telegram.org/js/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.route("https://api.eliza.app/api/eliza-app/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/eliza-app/auth/telegram") {
      authBodies.push(request.postDataJSON());
      return route.fulfill({
        json: {
          success: true,
          user: {
            id: "telegram-return-user",
            telegram_id: "123456789",
            telegram_username: "sam",
            phone_number: "+14155550123",
            name: "Sam",
            organization_id: "telegram-return-org",
          },
          session: {
            token: "redeemed-session-token",
            expires_at: "2026-08-09T00:00:00.000Z",
          },
          is_new_user: false,
          continuation_redeemed: true,
        },
      });
    }
    if (url.pathname === "/api/eliza-app/onboarding/chat") {
      browserContinuationCalls += 1;
      return route.fulfill({
        status: 500,
        json: { error: "unexpected browser redemption" },
      });
    }
    if (url.pathname === "/api/eliza-app/user/me") {
      return route.fulfill({
        json: {
          user: {
            id: "telegram-return-user",
            telegram_id: "123456789",
            telegram_username: "sam",
            telegram_first_name: "Sam",
            organization_id: "telegram-return-org",
            created_at: "2026-01-01T00:00:00.000Z",
          },
          organization: {
            id: "telegram-return-org",
            name: "Telegram Return Org",
            credit_balance: "5.00",
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Unhandled mock" } });
  });

  await page.goto(
    "/get-started?method=telegram&link=true&onboardingSession=opaque-session-id",
  );
  await page.getByRole("button", { name: /Connect Telegram/i }).click();
  await page.getByRole("textbox", { name: "Phone number" }).fill("4155550123");
  await page.getByRole("button", { name: "Complete Setup" }).click();

  await expect(page).toHaveURL(/\/connected\?from=telegram$/);
  await expect(
    page.getByRole("link", { name: "Return to Telegram" }),
  ).toBeVisible();
  expect(authBodies).toHaveLength(1);
  expect(authBodies[0]).toMatchObject({
    id: 123456789,
    phone_number: "+14155550123",
    onboarding_session: "opaque-session-id",
  });
  expect(browserContinuationCalls).toBe(0);
});

test("does not return to Telegram unless the server confirms redemption", async ({
  page,
}) => {
  await page.addInitScript((token) => {
    window.localStorage.setItem("eliza_app_session", token as string);
    const target = window as unknown as {
      Telegram: {
        Login: {
          auth: (
            options: { bot_id: string; request_access?: string },
            callback: (data: Record<string, unknown>) => void,
          ) => void;
        };
      };
    };
    target.Telegram = {
      Login: {
        auth: (_options, callback) =>
          callback({
            id: 123456789,
            first_name: "Sam",
            username: "sam",
            auth_date: 1_786_224_000,
            hash: "a".repeat(64),
          }),
      },
    };
  }, TEST_TOKEN);
  await page.route("https://telegram.org/js/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }),
  );
  await page.route("https://api.eliza.app/api/eliza-app/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/eliza-app/auth/telegram") {
      return route.fulfill({
        json: {
          success: true,
          user: {
            id: "telegram-return-user",
            telegram_id: "123456789",
            phone_number: "+14155550123",
            organization_id: "telegram-return-org",
          },
          session: {
            token: "unredeemed-session-token",
            expires_at: "2026-08-09T00:00:00.000Z",
          },
          is_new_user: false,
          continuation_redeemed: false,
        },
      });
    }
    if (url.pathname === "/api/eliza-app/user/me") {
      return route.fulfill({
        json: {
          user: {
            id: "telegram-return-user",
            telegram_id: "123456789",
            organization_id: "telegram-return-org",
            created_at: "2026-01-01T00:00:00.000Z",
          },
          organization: {
            id: "telegram-return-org",
            name: "Telegram Return Org",
            credit_balance: "5.00",
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Unhandled mock" } });
  });

  await page.goto(
    "/get-started?method=telegram&link=true&onboardingSession=opaque-session-id",
  );
  await page.getByRole("button", { name: /Connect Telegram/i }).click();
  await page.getByRole("textbox", { name: "Phone number" }).fill("4155550123");
  await page.getByRole("button", { name: "Complete Setup" }).click();

  await expect(page).toHaveURL(/\/get-started\?/);
  await expect(
    page.getByText(
      "We couldn't finish linking this Telegram chat. Return to the bot and request a new link.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Complete Setup" }),
  ).toBeEnabled();
});

test("a completed Telegram handoff offers a direct return to the bot", async ({
  page,
}, testInfo: TestInfo) => {
  await page.addInitScript((token) => {
    window.localStorage.setItem("eliza_app_session", token as string);
  }, TEST_TOKEN);
  await page.route("https://api.eliza.app/api/eliza-app/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/eliza-app/user/me") {
      return route.fulfill({
        json: {
          user: {
            id: "telegram-return-user",
            telegram_id: "1",
            telegram_username: "telegram_return_user",
            telegram_first_name: "Telegram",
            organization_id: "telegram-return-org",
            created_at: "2026-01-01T00:00:00.000Z",
          },
          organization: {
            id: "telegram-return-org",
            name: "Telegram Return Org",
            credit_balance: "5.00",
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: "Unhandled mock" } });
  });

  await page.goto("/connected?from=telegram", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByRole("heading", { name: "Connected." })).toBeVisible();
  const returnLink = page.getByRole("link", { name: "Return to Telegram" });
  await expect(returnLink).toBeVisible();
  await expect(returnLink).toHaveAttribute(
    "href",
    "https://t.me/ElizaIsNotABot",
  );
  await returnLink.focus();
  await expect(returnLink).toBeFocused();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);

  const contentBox = await page.getByTestId("connected-content").boundingBox();
  const footerBox = await page.locator("footer").boundingBox();
  const headerControlsBox = await page
    .locator("main > div.absolute.top-4.right-4")
    .boundingBox();
  if (!contentBox || !footerBox || !headerControlsBox) {
    throw new Error("Expected connected-page layout boxes");
  }
  expect(contentBox.y).toBeGreaterThanOrEqual(
    headerControlsBox.y + headerControlsBox.height,
  );
  expect(contentBox.y + contentBox.height).toBeLessThanOrEqual(footerBox.y);
  await page.locator("footer").scrollIntoViewIfNeeded();
  await expect(page.locator("footer")).toBeInViewport();

  await page.screenshot({
    path: testInfo.outputPath("telegram-return-mobile.png"),
    fullPage: true,
  });
});
