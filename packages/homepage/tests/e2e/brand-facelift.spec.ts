/** Focused coverage for the 2026 homepage brand facelift. */
import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import { expect, test } from "playwright/test";
import { releaseData } from "../../src/generated/release-data";

const RELEASES_URL = "https://github.com/elizaOS/eliza/releases";
const effectiveRelease = [
  releaseData.stableRelease,
  releaseData.canaryRelease,
  releaseData.release,
].find((release) => release && release.downloads.length > 0);
const effectiveReleaseUrl = effectiveRelease?.url ?? RELEASES_URL;
const hero = /^The agent that runs your life should belong to you\.$/;

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 390, height: 844 },
] as const) {
  test(`manifesto has no horizontal overflow at ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: hero })).toBeVisible();
    await expect(page.getByText("The Linux of agents.")).toBeVisible();
    await expect(
      page.getByText("Everyone else rents you an assistant.", { exact: false }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
}

test("functional destinations and complete release surface are preserved", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const nav = page.getByRole("navigation", { name: "Eliza products" });
  await expect(nav.getByRole("link", { name: "Web app" })).toHaveAttribute(
    "href",
    EXTERNAL_URLS.app,
  );
  await expect(nav.getByRole("link", { name: "Cloud" })).toHaveAttribute(
    "href",
    `${EXTERNAL_URLS.cloud}/login?intent=launch`,
  );
  await expect(nav.getByRole("link", { name: "OS" })).toHaveAttribute(
    "href",
    EXTERNAL_URLS.os,
  );
  await expect(nav.getByRole("link", { name: "Orange Paper" })).toHaveAttribute(
    "href",
    "/orange-paper",
  );
  await expect(
    page.getByRole("link", {
      name: effectiveRelease ? "Release notes" : "View releases",
    }),
  ).toHaveAttribute("href", effectiveReleaseUrl);
  await expect(page.locator(".life-download-row")).toHaveCount(6);
  await expect(page.locator(".life-download-row").first()).toContainText(
    "For M1, M2, M3, and newer Apple Silicon Macs.",
  );
  await expect(page.locator(".life-store-list li")).toHaveCount(
    releaseData.storeTargets.length,
  );
  await expect(
    page.locator('[data-testid="os-artifact-grid"] > li'),
  ).toHaveCount(releaseData.osArtifacts.length);
  for (const artifact of releaseData.osArtifacts) {
    await expect(
      page.locator(`[data-artifact-id="${artifact.id}"]`),
    ).toHaveCount(1);
  }
  if (effectiveRelease?.checksum) {
    await expect(
      page.getByRole("link", {
        name: new RegExp(effectiveRelease.checksum.fileName),
      }),
    ).toHaveAttribute("href", effectiveRelease.checksum.url);
  } else {
    await expect(
      page.getByText("Checksums publish with release assets."),
    ).toBeVisible();
  }
});

test("mobile navigation keeps every product destination available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const nav = page.getByRole("navigation", { name: "Eliza products" });
  for (const name of ["Web app", "Downloads", "Cloud", "OS", "Orange Paper"]) {
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await expect(
    page.getByText("Open source or it didn't happen."),
  ).toBeVisible();
});

test("Orange Paper and plan compatibility have distinct public metadata", async ({
  page,
}) => {
  for (const path of ["/orange-paper", "/plan"]) {
    await page.goto(`${path}/`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page).toHaveTitle("The Orange Paper | Eliza");
    await expect(
      page.getByRole("heading", { name: "Own your intelligence." }),
    ).toBeVisible();
    await expect(
      page.getByText("Cypherpunk by architecture, not aesthetic."),
    ).toBeVisible();
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      "The case for an open, private agent that belongs to you.",
    );
  }
});

test("reduced motion freezes the decorative banger while keeping all copy accessible", async ({
  browser,
}) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const word = page.locator(".life-banger-word");
  await expect(word).toHaveText("Eliza is yours.");
  await page.waitForTimeout(2800);
  await expect(word).toHaveText("Eliza is yours.");
  await expect(page.locator("#banger-accessible")).toContainText(
    "She remembers everything.",
  );
  await expect(word).toHaveCSS("animation-name", "none");
  await context.close();
});
