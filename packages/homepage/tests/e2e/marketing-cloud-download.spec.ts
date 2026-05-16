import { expect, type Locator, test } from "playwright/test";
import { releaseData } from "../../src/generated/release-data";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectCloudPath(locator: Locator) {
  const href = await locator.getAttribute("href");
  expect(href).toBeTruthy();
  const url = new URL(href ?? "", "https://www.elizacloud.ai");
  expect(url.hostname).toBe("www.elizacloud.ai");
  expect(url.pathname).toMatch(/^\/dashboard\/my-agents\/?$/);
}

async function expectExternalOrLocal(locator: Locator, productionHost: string) {
  const href = await locator.getAttribute("href");
  expect(href).toBeTruthy();
  const host = new URL(href ?? "", `https://${productionHost}`).hostname;
  expect([productionHost, "localhost", "127.0.0.1"]).toContain(host);
}

test("homepage centers Eliza App downloads and product CTAs", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    )
    .toBe(0);

  await expect(page).toHaveTitle("Eliza App - Download the app");
  await expect(
    page.getByRole("heading", { name: /^Download the app\.$/ }),
  ).toBeVisible();

  const productNav = page.getByRole("navigation", {
    name: "Eliza products",
  });
  await expect(productNav.getByRole("link", { name: /^Eliza App$/ }))
    .toHaveAttribute("href", "/");
  await expectExternalOrLocal(
    productNav.getByRole("link", { name: /^ElizaOS$/ }),
    "elizaos.ai",
  );
  await expectCloudPath(
    productNav.getByRole("link", { name: /^Eliza Cloud$/ }),
  );

  await expect(
    page.getByRole("link", { name: /^Download the app$/ }).first(),
  ).toHaveAttribute("href", "#download");
  await expectExternalOrLocal(
    page.getByRole("link", { name: /^ElizaOS$/ }).first(),
    "elizaos.ai",
  );
  await expectCloudPath(
    page.getByRole("link", { name: /^Eliza Cloud$/ }).first(),
  );

  await page
    .getByRole("link", { name: /^Download the app$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/#download$/);
  await expect(
    page.getByRole("heading", { name: /^Install Eliza App\.$/ }),
  ).toBeVisible();

  await expect(page.getByText(/^macOS Apple Silicon/)).toBeVisible();
  await expect(page.getByText(/^Windows x64/)).toBeVisible();
  await expect(page.getByText(/^Linux AppImage/)).toBeVisible();
  await expect(page.getByText(/^Android APK/)).toBeVisible();

  for (const download of releaseData.release.downloads) {
    await expect(
      page.getByText(
        new RegExp(`From ${escapeRegExp(download.releaseTagName)}`),
      ),
    ).toBeVisible();
  }

  if (releaseData.release.downloads.length === 0) {
    await expect(page.getByText("Opens release page")).toHaveCount(4);
    await expect(
      page.getByRole("link", { name: /macOS Apple Silicon/i }),
    ).toHaveAttribute("href", /^https:\/\/github\.com\/elizaOS\/eliza\/releases$/);
  }

  await expect(page.locator('[aria-disabled="true"]')).toHaveCount(4);
  for (const store of releaseData.storeTargets) {
    const row = page.locator('[aria-disabled="true"]').filter({
      hasText: store.label,
    });
    await expect(row).toBeVisible();
    await expect(row.getByText(store.reviewState)).toBeVisible();
    await expect(row.getByText("Coming soon")).toBeVisible();
    await expect(row.locator("a")).toHaveCount(0);
  }

  await expect(
    page.getByRole("heading", { name: /^Build on ElizaOS\.$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /^Go to ElizaOS$/ }),
  ).toHaveAttribute("href", /^https:\/\/elizaos\.ai\/?$/);
  await expect(
    page.getByRole("heading", { name: /^Continue in Eliza Cloud\.$/ }),
  ).toBeVisible();
  await expectCloudPath(page.getByRole("link", { name: /^Try Eliza Cloud$/ }));

  await expect(
    page.locator(".app-shell"),
  ).toHaveCSS("font-family", "Poppins");
  await expect(page.locator(".brand-section").first()).toHaveCSS(
    "border-radius",
    "0px",
  );
});
