import { expect, test } from "playwright/test";

const CHECKOUT_BASE = "https://elizaos.ai/checkout";
const USB_SKU = "elizaos-usb";

test("homepage hardware tile links to /hardware/:slug detail page", async ({
  page,
}) => {
  await page.goto("/");

  const hardwareSection = page.locator("#hardware");
  await hardwareSection.scrollIntoViewIfNeeded();
  await expect(hardwareSection.getByRole("heading", { name: "Hardware." })).toBeVisible();

  const usbTile = page.locator(`a.hw-tile[href="/hardware/usb"]`);
  await expect(usbTile).toBeVisible();
  await expect(usbTile).toContainText("ElizaOS USB");
  await expect(usbTile).toContainText("$49");

  await usbTile.click();
  await expect(page).toHaveURL(/\/hardware\/usb$/);
});

test("product detail page shows ElizaOS USB hero, price, and pre-order CTA pointing to elizaos.ai checkout", async ({
  page,
}) => {
  await page.goto("/hardware/usb");

  const heading = page.getByRole("heading", { level: 1, name: "ElizaOS USB" });
  await expect(heading).toBeVisible();

  // Price + ships meta
  await expect(page.locator(".detail-meta")).toContainText("$49");
  await expect(page.locator(".detail-meta")).toContainText("Ships October 2026");

  // Pre-order CTA exists and points at elizaos.ai/checkout?sku=elizaos-usb
  const preorderCta = page.getByRole("link", {
    name: /Pre-order on elizaos\.ai/i,
  });
  await expect(preorderCta).toBeVisible();
  await expect(preorderCta).toHaveAttribute(
    "href",
    `${CHECKOUT_BASE}?sku=${USB_SKU}`,
  );

  // Confirm checkout-stays-on-elizaos.ai note
  await expect(page.locator(".detail-note")).toContainText(
    "Checkout stays on elizaos.ai.",
  );
});

test("clicking pre-order does not navigate inside the spec; URL is asserted instead", async ({
  page,
}) => {
  await page.goto("/hardware/usb");

  const preorderCta = page.getByRole("link", {
    name: /Pre-order on elizaos\.ai/i,
  });

  // Read destination without following it (avoid leaving the test origin).
  const href = await preorderCta.getAttribute("href");
  expect(href).toBe(`${CHECKOUT_BASE}?sku=${USB_SKU}`);

  const url = new URL(href as string);
  expect(url.origin).toBe("https://elizaos.ai");
  expect(url.pathname).toBe("/checkout");
  expect(url.searchParams.get("sku")).toBe(USB_SKU);
});
