// Exercises the OS homepage route, checkout, and visual behavior.
import { expect, test } from "playwright/test";

const heroCopy = [
  "The agentic operating system.",
  "For devices that run themselves.",
];

const installerCopy = [
  "Download beta.",
  "ElizaOS beta",
  "ElizaOS Linux live beta",
  "ElizaOS USB installer for Windows",
  "ElizaOS VM launcher for Apple Silicon",
  "ElizaOS Android beta image bundle",
  "x86_64",
  "arm64",
  "Downloads are temporarily unavailable.",
  "Unavailable",
];

const hardwareCopy = [
  "Hardware.",
  "ElizaOS USB",
  "Raspberry Pi case",
  "Custom Raspberry Pi + case",
  "ElizaOS mini PC",
  "ElizaOS Phone",
  "ElizaOS Box",
  "$49",
  "$149",
  "$1999",
  "Ships October 2026",
];

test("lander renders elizaOS hero and primary copy", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("h1", { timeout: 15000 });

  const hero = page.locator(".hero-cloud");
  await expect(hero).toBeVisible();
  await expect(hero).toHaveAttribute("data-hero", "cloud");
  await expect(hero.locator(".cloud-scrim")).toHaveCount(1);
  await expect(hero.getByRole("link", { name: /^Download/i })).toHaveAttribute(
    "href",
    "#download",
  );

  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toContainText(/operating system/i);
  await expect(h1).toContainText(/agent/i);

  for (const copy of [...heroCopy, ...installerCopy, ...hardwareCopy]) {
    await expect(page.getByText(copy, { exact: false }).first()).toBeVisible();
  }
});

test("download section distinguishes unavailable release artifacts", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector("h1", { timeout: 15000 });
  await page
    .getByRole("link", { name: /^Download/i })
    .first()
    .click();

  const downloads = page.locator("#download");
  await expect(downloads).toBeVisible();

  await expect(
    downloads.getByText("Downloads are temporarily unavailable."),
  ).toBeVisible();
  await expect(downloads.getByRole("link", { name: "Download" })).toHaveCount(
    0,
  );
  await expect(downloads.getByText("Unavailable", { exact: true })).toHaveCount(
    4,
  );
});

test("anchor sections #download and #hardware exist and are reachable", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector("h1", { timeout: 15000 });

  await expect(page.locator("#download")).toHaveCount(1);
  await expect(page.locator("#hardware")).toHaveCount(1);

  await expect(
    page.getByRole("link", { name: /^Download/i }).first(),
  ).toHaveAttribute("href", "/#download");
  await expect(
    page.getByRole("link", { name: /^Hardware/i }).first(),
  ).toHaveAttribute("href", "/#hardware");

  const order = await page.evaluate(() => {
    const d = document.querySelector("#download")?.getBoundingClientRect();
    const h = document.querySelector("#hardware")?.getBoundingClientRect();
    return { d: d?.top ?? 0, h: h?.top ?? 0 };
  });
  expect(order.d).toBeLessThan(order.h);
});

test("footer renders wordmark, link nav, and social links", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector("h1", { timeout: 15000 });

  const footer = page.locator("footer.site-footer");
  await expect(footer).toBeVisible();
  await expect(footer.locator("img")).toHaveCount(1);
  await expect(footer.getByRole("link", { name: "App" })).toHaveAttribute(
    "href",
    "https://app.elizacloud.ai",
  );
  await expect(footer.getByRole("link", { name: "Cloud" })).toHaveAttribute(
    "href",
    /elizacloud\.ai/,
  );
});

test("hero has no horizontal overflow", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("h1", { timeout: 15000 });

  const metrics = await page.evaluate(() => ({
    horizontalOverflow:
      document.documentElement.scrollWidth > window.innerWidth,
  }));
  expect(metrics.horizontalOverflow).toBe(false);
});

test("hardware tiles link to checkout per product", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("h1", { timeout: 15000 });
  await expect(
    page.getByRole("link", { name: /Open checkout/i }),
  ).toHaveAttribute("href", "/checkout?collection=elizaos-hardware");
});

test("checkout lives on elizaOS and starts with Eliza Cloud auth", async ({
  page,
}) => {
  await page.goto("/checkout?sku=elizaos-usb");
  await page.waitForSelector("h1, h2", { timeout: 15000 });

  await expect(
    page.getByRole("heading", { name: "ElizaOS USB" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Checkout on elizaOS." }),
  ).toBeVisible();
  await expect(page.locator(".checkout-product-shot img")).toHaveAttribute(
    "src",
    "/brand/concepts/concept_usbdrive_900.jpg",
  );

  await page.getByRole("button", { name: /ElizaOS mini PC/i }).click();
  await expect(page).toHaveURL(/\/checkout\?sku=elizaos-mini-pc$/);
  await expect(
    page.getByRole("heading", { name: "ElizaOS mini PC" }),
  ).toBeVisible();

  await page.goto("/checkout?sku=elizaos-usb");
  await Promise.all([
    page.waitForURL(
      /api\.elizacloud\.ai\/steward\/auth\/oauth\/google\/authorize.*code_challenge=/,
      { timeout: 15000 },
    ),
    page.getByRole("button", { name: "Google" }).click(),
  ]);
  expect(page.url()).toMatch(
    /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A4455%2Fcheckout%3Fsku%3Delizaos-usb/,
  );
});

test("checkout result pages return to hardware", async ({ page }) => {
  await page.goto("/checkout/success?sku=elizaos-usb");
  await page.waitForSelector("h1, h2", { timeout: 15000 });
  await expect(
    page.getByRole("heading", { name: "Pre-order received." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Back to elizaOS" }),
  ).toHaveAttribute("href", "/#hardware");

  await page.goto("/checkout/cancel?sku=elizaos-usb");
  await page.waitForSelector("h1, h2", { timeout: 15000 });
  await expect(
    page.getByRole("heading", { name: "Checkout canceled." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Return to hardware" }),
  ).toHaveAttribute("href", "/#hardware");
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
    await page.waitForSelector("h1, h2", { timeout: 15000 });

    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Pre-order checkout/i }),
    ).toHaveAttribute("href", `/checkout?sku=${sku}`);
    await expect(page.getByText("Checkout stays on elizaOS.")).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Download beta/i }),
    ).toHaveAttribute("href", "/downloads/elizaos-beta-manifest.json");
  });
}
