/**
 * Production checks for the sovereign homepage, live release links, and public paper.
 */
import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import { expect, test } from "playwright/test";
import { releaseData } from "../../src/generated/release-data";

const primaryIds = [
  "macos-arm64",
  "macos-x64",
  "windows-x64",
  "linux-x64",
  "linux-deb",
  "android-apk",
] as const;

test("homepage states the thesis and keeps one primary action", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page).toHaveTitle("elizaOS | Sovereign intelligence");
  await expect(
    page.getByRole("heading", {
      name: /Bitcoin gave you sovereign money.*elizaOS gives you a sovereign mind/i,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("The open OS for private, persistent agents."),
  ).toBeVisible();

  const primary = page.locator(".sovereign-primary");
  await expect(primary).toHaveCount(1);
  await expect(primary).toContainText("Download Eliza");
  await expect(primary).toHaveAttribute("href", "#download");

  const webApp = page.getByRole("link", { name: /^Open web app/i });
  await expect(webApp).toHaveAttribute("href", EXTERNAL_URLS.app);
  await expect(
    page.getByRole("link", { name: "Orange Paper", exact: true }),
  ).toHaveAttribute("href", "/orange-paper");
});

test("sovereign homepage copy remains localized", async ({ page }) => {
  await page.goto("/?lang=es", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: /Bitcoin te dio dinero soberano/i }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Sistema" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Descargar Eliza" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("elizaOS | Inteligencia soberana");

  await page.goto("/orange-paper?lang=es", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Haz tuya tu inteligencia." }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Haz tuya tu inteligencia. | elizaOS");
});

test("download rows resolve to release assets or the release fallback", async ({
  page,
}) => {
  await page.goto("/#download", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Download Eliza." }),
  ).toBeVisible();

  const stable = releaseData.release.downloads;
  const canary = releaseData.canaryRelease?.downloads ?? [];
  const effective = stable.length > 0 ? stable : canary;

  for (const [index, id] of primaryIds.entries()) {
    const expected =
      effective.find((download) => download.id === id)?.url ??
      `${EXTERNAL_URLS.github}/releases`;
    await expect(
      page.locator(".sovereign-download-list a").nth(index),
    ).toHaveAttribute("href", expected);
  }

  await expect(
    page.locator('.app-download-grid [aria-disabled="true"]'),
  ).toHaveCount(0);
  await expect(page.getByTestId("os-artifact-grid")).toHaveCount(1);
  await expect(
    page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: "GitHub" }),
  ).toHaveAttribute("href", EXTERNAL_URLS.github);
  await expect(page.getByRole("link", { name: "Cloud" })).toHaveAttribute(
    "href",
    EXTERNAL_URLS.cloud,
  );
});

test("orange paper and plan compatibility route expose the public thesis", async ({
  page,
}) => {
  for (const route of ["/orange-paper", "/orange-paper/", "/plan", "/plan/"]) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: "Own your intelligence." }),
    ).toBeVisible();
    await expect(page).toHaveTitle("Own your intelligence. | elizaOS");
    await expect(
      page.getByRole("heading", { name: "Every surface, the same agent." }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Persistent without becoming public.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Open software. Commercial operations.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Privacy as a requirement." }),
    ).toBeVisible();
    await expect(page.locator("main")).not.toContainText("Strata");
    await expect(page.locator("main")).not.toContainText("cap table");
  }
});

test("homepage has no em dash, no horizontal overflow, and visible keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBe(0);
  expect(await page.locator("body").innerText()).not.toContain("—");

  const focused = page.getByRole("link", { name: /^Download Eliza/i }).first();
  await focused.focus();
  await expect(focused).toBeFocused();
  const outline = await focused.evaluate(
    (element) => getComputedStyle(element).outlineStyle,
  );
  expect(outline).not.toBe("none");

  const targets = await page
    .locator("a:visible, summary:visible")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: element.textContent?.trim(),
          width: rect.width,
          height: rect.height,
        };
      }),
    );
  expect(
    targets.filter((target) => target.width < 44 || target.height < 44),
  ).toEqual([]);
});
