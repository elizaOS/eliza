import { expect, test } from "playwright/test";

const requiredCopy = [
  "The agentic operating system for devices that run themselves.",
  "Shop hardware",
  "Download beta",
  "ElizaOS Phone",
  "ElizaOS Box",
  "Chibi USB key",
  "Branded USB key",
  "$49",
  "Ships October 2026",
  "Buy in Cloud",
  "Hardware orders live in Eliza Cloud.",
  "Supported Mac hardware is limited",
];

test("homepage exposes simplified hardware purchase and install story", async ({
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
    page.getByRole("link", { name: /Open Cloud checkout/i }),
  ).toHaveAttribute(
    "href",
    "https://elizacloud.ai/checkout?collection=elizaos-hardware",
  );
  await expect(
    page.getByRole("link", { name: /Buy in Cloud/i }).first(),
  ).toHaveAttribute("href", /https:\/\/elizacloud\.ai\/checkout\?sku=/);
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
