import { expect, test } from "playwright/test";

test.setTimeout(180_000);

test("get-started public method controls work without API mocks", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto("/get-started", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Anywhere you want her to be." }),
  ).toBeVisible();

  await page.getByRole("button", { name: /^iMessage$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Ready to chat!" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open iMessage" }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "I also want to use Telegram" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Connect with Telegram" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Connect Telegram/i }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Back" }).click();
  await expect(
    page.getByRole("heading", { name: "Anywhere you want her to be." }),
  ).toBeVisible();

  await page.getByRole("button", { name: /^WhatsApp$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Chat on WhatsApp!" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Open WhatsApp/i }),
  ).toBeVisible();

  await page
    .getByRole("button", { name: "I also want to use Telegram" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Connect with Telegram" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: /^Telegram$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Connect with Telegram" }),
  ).toBeVisible();
});
