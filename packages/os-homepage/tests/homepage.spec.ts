import { expect, test } from "playwright/test";

const requiredCopy = [
  "The agentic operating system for devices that run themselves.",
  "Download/install elizaOS",
  "Download ElizaOS",
  "Download Eliza App",
  "Run in Eliza Cloud",
  "Choose the installer for your device.",
  "Pre-order hardware on elizaos.ai.",
  "ElizaOS USB",
  "Raspberry Pi case",
  "Custom Raspberry Pi + case",
  "ElizaOS mini PC",
  "$49",
  "$149",
  "$1999",
  "Ships October 2026",
  "Supported Mac hardware is limited",
];

test("homepage focuses on install before integrated hardware preorder", async ({
  page,
}) => {
  await page.goto("/");

  for (const copy of requiredCopy) {
    const matches = page.getByText(copy, { exact: false });
    expect(await matches.count(), copy).toBeGreaterThan(0);
    await expect(matches.first()).toBeVisible();
  }

  await expect(
    page.getByRole("navigation", { name: "Product switcher" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Download\/install elizaOS/i }).first(),
  ).toHaveAttribute("href", "#downloads");
  await expect(
    page.getByRole("link", { name: /Open checkout/i }),
  ).toHaveAttribute(
    "href",
    /^https:\/\/elizaos\.ai\/checkout\?collection=elizaos-hardware$/,
  );
  await expect(
    page
      .locator(".product-row")
      .getByRole("link", { name: "Pre-order" })
      .first(),
  ).toHaveAttribute("href", /^https:\/\/elizaos\.ai\/checkout\?sku=/);

  const sectionOrder = await page.evaluate(() => {
    const downloads = document
      .querySelector("#downloads")
      ?.getBoundingClientRect();
    const hardware = document
      .querySelector("#hardware")
      ?.getBoundingClientRect();
    return {
      downloadsTop: downloads?.top ?? 0,
      hardwareTop: hardware?.top ?? 0,
    };
  });

  expect(sectionOrder.downloadsTop).toBeLessThan(sectionOrder.hardwareTop);
});

test("homepage removes verbose release planning copy", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("What has to ship together")).toHaveCount(0);
  await expect(page.getByText("Prepared for GitHub releases")).toHaveCount(0);
  await expect(page.getByText("Source on GitHub")).toHaveCount(0);
  await expect(page.locator(".product-card")).toHaveCount(0);
});

test("hero has no horizontal overflow and keeps primary action visible", async ({
  page,
}) => {
  await page.goto("/");

  const metrics = await page.evaluate(() => {
    const cta = document
      .querySelector(".hero-actions")
      ?.getBoundingClientRect();
    return {
      ctaVisible: Boolean(cta && cta.bottom <= window.innerHeight),
      horizontalOverflow:
        document.documentElement.scrollWidth > window.innerWidth,
    };
  });

  expect(metrics.horizontalOverflow).toBe(false);
  expect(metrics.ctaVisible).toBe(true);
});

for (const product of [
  ["usb", "ElizaOS USB", "elizaos-usb"],
  ["case", "Raspberry Pi case", "elizaos-raspberry-pi-case"],
  [
    "raspberry-pi",
    "Custom Raspberry Pi + case",
    "elizaos-custom-raspberry-pi-case",
  ],
  ["mini-pc", "ElizaOS mini PC", "elizaos-mini-pc"],
  ["phone", "ElizaOS Phone", "elizaos-phone"],
  ["box", "ElizaOS Box", "elizaos-box"],
  ["chibi-usb", "Chibi USB key", "elizaos-usb-chibi"],
] as const) {
  test(`hardware detail page supports preorder for ${product[1]}`, async ({
    page,
  }) => {
    const [slug, name, sku] = product;

    await page.goto(`/hardware/${slug}`);

    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Pre-order on elizaos.ai/i }),
    ).toHaveAttribute("href", `https://elizaos.ai/checkout?sku=${sku}`);
    await expect(page.getByText("Checkout stays on elizaos.ai.")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Download beta/i }),
    ).toHaveAttribute("href", "/downloads/elizaos-beta-manifest.json");
  });
}
