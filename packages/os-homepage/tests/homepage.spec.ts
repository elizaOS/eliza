import { expect, test } from "playwright/test";

const requiredCopy = [
  "The agentic operating system for devices that run themselves.",
  "Download ElizaOS",
  "Download Eliza App",
  "Run in Eliza Cloud",
  "Choose the installer for your device.",
  "Pre-order hardware",
  "ElizaOS Phone",
  "ElizaOS Box",
  "Chibi USB key",
  "Branded USB key",
  "$49",
  "Ships October 2026",
  "Pre-order",
  "Hardware orders live in Eliza Cloud.",
  "Supported Mac hardware is limited",
];

test("homepage focuses on downloads before hardware preorder", async ({
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
    page.getByRole("navigation", { name: "Product switcher" }).getByText("App"),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("navigation", { name: "Product switcher" })
      .getByText("Cloud"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /Download ElizaOS/i }).first(),
  ).toHaveAttribute("href", "#downloads");
  await expect(
    page.getByRole("link", { name: /Open Cloud checkout/i }),
  ).toHaveAttribute("href", /\/checkout\?collection=elizaos-hardware$/);
  await expect(
    page
      .locator(".product-card")
      .getByRole("link", { name: "Pre-order" })
      .first(),
  ).toHaveAttribute("href", /\/checkout\?sku=/);

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
  ["phone", "ElizaOS Phone", "elizaos-phone"],
  ["box", "ElizaOS Box", "elizaos-box"],
  ["usb", "Branded USB key", "elizaos-usb-plastic"],
  ["usb-chibi", "Chibi USB key", "elizaos-usb-chibi"],
] as const) {
  test(`hardware detail page supports preorder for ${product[1]}`, async ({
    page,
  }) => {
    const [slug, name, sku] = product;

    await page.goto(`/hardware/${slug}`);

    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Pre-order in Eliza Cloud/i }),
    ).toHaveAttribute("href", new RegExp(`/checkout\\?sku=${sku}$`));
    await expect(
      page.getByText("Checkout continues in Eliza Cloud."),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Download beta/i }),
    ).toHaveAttribute("href", "/downloads/elizaos-beta-manifest.json");
  });
}
