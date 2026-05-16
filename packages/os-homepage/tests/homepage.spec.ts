import { expect, test } from "playwright/test";

const heroCopy = [
  "An operating system for your agent.",
  "Local first",
  "Open source",
];

const installerCopy = [
  "Install elizaOS.",
  "Linux PC",
  "ISO + USB installer",
  "VM launcher",
  "Mac, Windows, Linux",
  "Android",
  "APK + AOSP image",
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

test("lander renders hero with cloud video and primary copy", async ({
  page,
}) => {
  await page.goto("/");

  const heroVideo = page.locator('[data-testid="cloud-video"]');
  await expect(heroVideo).toHaveCount(1);

  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toContainText(/operating system/i);
  await expect(h1).toContainText(/agent/i);

  for (const copy of [...heroCopy, ...installerCopy, ...hardwareCopy]) {
    await expect(page.getByText(copy, { exact: false }).first()).toBeVisible();
  }
});

test("anchor sections #download and #hardware exist and are reachable", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.locator("#download")).toHaveCount(1);
  await expect(page.locator("#hardware")).toHaveCount(1);

  await expect(
    page.getByRole("link", { name: /^Download/i }).first(),
  ).toHaveAttribute("href", "#download");
  await expect(
    page.getByRole("link", { name: /^Hardware/i }).first(),
  ).toHaveAttribute("href", "#hardware");

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

  const footer = page.locator("footer.site-footer");
  await expect(footer).toBeVisible();
  await expect(footer.locator("img")).toHaveCount(1);
  await expect(footer.getByRole("link", { name: "App" })).toHaveAttribute(
    "href",
    "https://eliza.app",
  );
  await expect(footer.getByRole("link", { name: "Cloud" })).toHaveAttribute(
    "href",
    /elizacloud\.ai/,
  );
  await expect(footer.getByRole("link", { name: "GitHub" })).toHaveAttribute(
    "href",
    /github\.com\/elizaOS/,
  );
  await expect(footer.getByRole("link", { name: "X" })).toHaveAttribute(
    "href",
    /x\.com\/elizaos/,
  );
});

test("hero has no horizontal overflow", async ({ page }) => {
  await page.goto("/");

  const metrics = await page.evaluate(() => ({
    horizontalOverflow:
      document.documentElement.scrollWidth > window.innerWidth,
  }));
  expect(metrics.horizontalOverflow).toBe(false);
});

test("hardware tiles link to checkout per product", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: /Open checkout/i }),
  ).toHaveAttribute(
    "href",
    /^https:\/\/elizaos\.ai\/checkout\?collection=elizaos-hardware$/,
  );
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
