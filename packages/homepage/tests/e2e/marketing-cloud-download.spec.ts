import { expect, type Locator, test } from "playwright/test";
import { releaseData } from "../../src/generated/release-data";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectCloudPath(locator: Locator) {
  const href = await locator.getAttribute("href");
  expect(href).toBeTruthy();
  const url = new URL(href ?? "", "https://www.elizacloud.ai");
  expect(["elizacloud.ai", "www.elizacloud.ai"]).toContain(url.hostname);
  expect(url.pathname).toMatch(/^\/login\/?$/);
  expect(url.searchParams.get("intent")).toBe("launch");
}

async function _expectExternalOrLocal(
  locator: Locator,
  productionHost: string,
) {
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

  await expect(page).toHaveTitle("Eliza — your agent, everywhere");
  await expect(
    page.getByRole("heading", { name: /^Your Eliza, everywhere\.$/ }),
  ).toBeVisible();

  const productNav = page.getByRole("navigation", {
    name: "Eliza products",
  });
  await expect(
    productNav.getByRole("link", { name: /^Download$/ }),
  ).toHaveAttribute("href", "#download");
  await expectCloudPath(productNav.getByRole("link", { name: /^Cloud$/ }));

  await expect(
    page.getByRole("link", { name: /^Download$/ }).first(),
  ).toHaveAttribute("href", "#download");
  await expectCloudPath(
    page.getByRole("link", { name: /^Try Eliza Cloud$/ }).first(),
  );

  await page
    .getByRole("link", { name: /^Download$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/#download$/);
  await expect(
    page.getByRole("heading", { name: /^Install the app\.$/ }),
  ).toBeVisible();

  await expect(
    page.getByRole("link", { name: /macOS \(Apple Silicon\)/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /macOS \(Intel\)/i }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /^Windows/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Linux/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Android APK/i })).toBeVisible();

  await expect(
    page.getByText(
      new RegExp(`From ${escapeRegExp(releaseData.release.tagName)}`),
    ),
  ).toHaveCount(releaseData.release.downloads.length);

  if (releaseData.release.downloads.length === 0) {
    await expect(page.getByText("Opens release page")).toHaveCount(4);
    await expect(
      page.getByRole("link", {
        name: /macOS Apple Silicon|macOS \(Apple Silicon\)/i,
      }),
    ).toHaveAttribute(
      "href",
      /^https:\/\/github\.com\/elizaOS\/eliza\/releases$/,
    );
  }

  await expect(page.locator('[aria-disabled="true"]')).toHaveCount(0);

  await expect(
    page.getByRole("heading", { name: /^Install ElizaOS\.$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /^Install ElizaOS$/ }).first(),
  ).toHaveAttribute("href", /^https:\/\/elizaos\.ai\/?$/);
  await expect(
    page.getByRole("heading", { name: /^Run in Cloud\.$/ }),
  ).toBeVisible();
  await expectCloudPath(
    page.getByRole("link", { name: /^Try Eliza Cloud$/ }).last(),
  );

  await expect(page.locator(".app-shell")).toHaveCSS("font-family", "Poppins");
  await expect(page.locator(".brand-section").first()).toHaveCSS(
    "border-radius",
    "0px",
  );
});
