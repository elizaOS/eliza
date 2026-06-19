import { expect, test } from "playwright/test";

test("hardware detail navigation survives browser back and forward", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /The agentic operating system/i }),
  ).toBeVisible();

  const hardwareSection = page.locator("#hardware");
  await hardwareSection.scrollIntoViewIfNeeded();
  await hardwareSection.locator(`a.hw-tile[href="/hardware/usb"]`).click();

  await expect(page).toHaveURL(/\/hardware\/usb$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "ElizaOS USB" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Pre-order checkout/i }),
  ).toHaveAttribute("href", "/checkout?sku=elizaos-usb");

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("#hardware")).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/hardware\/usb$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "ElizaOS USB" }),
  ).toBeVisible();
});

test("hostile path, query, and hash input render inert homepage content", async ({
  page,
}) => {
  const hostile = encodeURIComponent(`<img src=x onerror=alert("owned")>`);
  const alerts: string[] = [];
  page.on("dialog", async (dialog) => {
    alerts.push(dialog.message());
    await dialog.dismiss();
  });

  await page.goto(`/hardware/${hostile}?sku=${hostile}#${hostile}`);

  await expect(
    page.getByRole("heading", { name: /The agentic operating system/i }),
  ).toBeVisible();
  await expect(page.getByText("<img src=x")).toHaveCount(0);
  expect(alerts).toEqual([]);
});

test("download manifest failure falls back to embedded release links", async ({
  page,
}) => {
  await page.route("**/downloads/elizaos-beta-manifest.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      status: 503,
      body: JSON.stringify({ error: "manifest unavailable" }),
    }),
  );

  await page.goto("/");

  const downloads = page.locator("#download");
  await expect(downloads).toBeVisible();
  await expect(downloads.getByText("ElizaOS beta")).toBeVisible();
  await expect(
    downloads.getByRole("link", { name: "Download" }).first(),
  ).toHaveAttribute("href", /github\.com\/elizaOS\/eliza\/releases\/download/);
  await expect(
    downloads.getByRole("link", { name: "SHA256" }).first(),
  ).toHaveAttribute("href", /SHA256SUMS\.txt$/);
});
