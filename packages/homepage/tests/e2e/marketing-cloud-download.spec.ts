import { expect, type Locator, test } from "playwright/test";
import { releaseData } from "../../src/generated/release-data";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectCloudPath(locator: Locator) {
  const href = await locator.getAttribute("href");
  expect(href).toBeTruthy();
  expect(new URL(href ?? "", "https://www.elizacloud.ai").pathname).toMatch(
    /^\/dashboard\/my-agents\/?$/,
  );
}

async function expectExternalOrLocal(locator: Locator, productionHost: string) {
  const href = await locator.getAttribute("href");
  expect(href).toBeTruthy();
  const host = new URL(href ?? "", `https://${productionHost}`).hostname;
  expect([productionHost, "localhost", "127.0.0.1"]).toContain(host);
}

test("homepage exposes app downloads, stores, and cloud entrypoints", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  await expect
    .poll(async () => {
      try {
        return await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    })
    .toBe(0);

  await expect(
    page.getByRole("heading", { name: /^Your Eliza, everywhere\.$/ }),
  ).toBeVisible();
  await expectCloudPath(page.getByRole("link", { name: /^Try Eliza Cloud$/ }));
  await expect(
    page.getByRole("link", { name: /^Download the app$/ }).first(),
  ).toHaveAttribute("href", "#download");
  const productSwitcher = page.getByRole("navigation").first();
  await expectExternalOrLocal(
    productSwitcher.getByRole("link", { name: /^ElizaOS$/ }),
    "elizaos.ai",
  );
  await expect(
    productSwitcher.getByRole("link", { name: /^Eliza App$/ }),
  ).toHaveAttribute("href", "/");
  await expectExternalOrLocal(
    productSwitcher.getByRole("link", { name: /^Eliza Cloud$/ }),
    "www.elizacloud.ai",
  );
  await expect(page).toHaveTitle("Eliza App - Your Eliza, everywhere.");

  await expect(
    page.getByRole("heading", { name: /^Eliza Cloud$/ }),
  ).toBeVisible();
  await expect(
    page.getByText(/Hosted runtime, dashboard, API keys, billing/i),
  ).toBeVisible();
  await expectCloudPath(
    page.getByRole("link", { name: /Eliza Cloud.*Try Eliza Cloud/ }),
  );

  await page
    .getByRole("link", { name: /^Download the app$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/#download$/);
  await expect(
    page.getByRole("heading", { name: /^Install the app directly\.$/ }),
  ).toBeVisible();
  await expect(page.getByText(/^macOS: Apple Silicon/)).toBeVisible();
  await expect(page.getByText(/^Windows: x64 installer/)).toBeVisible();
  await expect(page.getByText(/^Linux: \.deb, \.rpm/)).toBeVisible();
  await expect(page.getByText(/^Mobile: iOS App Store/)).toBeVisible();
  await expect(
    page.getByRole("link", { name: /macOS Apple Silicon/i }),
  ).toHaveAttribute("href", /releases\/latest\/download|github\.com/);
  await expect(page.getByRole("link", { name: /^Windows/i })).toHaveAttribute(
    "href",
    /releases\/latest\/download|github\.com/,
  );
  await expect(
    page.getByRole("link", { name: /AppImage|Tarball/i }).first(),
  ).toHaveAttribute("href", /releases\/latest\/download|github\.com/);
  await expect(
    page.getByRole("link", { name: /Android APK/i }),
  ).toHaveAttribute("href", /releases\/latest\/download|github\.com/);

  await expect(page.locator('[aria-disabled="true"]')).toHaveCount(4);
  for (const store of [
    "iOS App Store",
    "Google Play Store",
    "Mac App Store",
    "Microsoft Store",
  ]) {
    const card = page.locator('[aria-disabled="true"]').filter({
      hasText: store,
    });
    await expect(card).toBeVisible();
    await expect(
      card.getByText("Coming soon", { exact: true }).first(),
    ).toBeVisible();
    await expect(card.locator("a")).toHaveCount(0);
    await expect(card.getByText("not-submitted")).toBeVisible();
  }

  await expect(page.getByText(/^Start in chat\. Finish/)).toBeVisible();
  await expect(
    page.getByText(/Cloud provisions one personal agent/i),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Telegram.*Start onboarding/i }),
  ).toHaveAttribute("href", "/get-started?method=telegram");
  await expect(page.getByText(/One personal agent/i).first()).toBeVisible();
  await expect(
    page.getByText(/brew install|snap install|flatpak install/i),
  ).toHaveCount(0);

  if (releaseData.release.downloads.length > 0) {
    const requiredIds = new Set([
      "macos-arm64",
      "macos-x64",
      "windows-x64",
      "linux-x64",
      "linux-deb",
      "linux-rpm",
      "android-apk",
    ]);
    const downloadIds = new Set(
      releaseData.release.downloads.map((download) => download.id),
    );
    for (const requiredId of requiredIds) {
      expect(downloadIds.has(requiredId), `missing ${requiredId}`).toBe(true);
    }
    for (const download of releaseData.release.downloads) {
      expect(download.releaseTagName).not.toBe("unavailable");
      expect(download.releaseUrl).toContain("/releases/tag/");
      expect(download.url).toContain(
        `/releases/download/${download.releaseTagName}/`,
      );
      await expect(
        page.getByText(
          new RegExp(`From ${escapeRegExp(download.releaseTagName)}`),
        ),
      ).toBeVisible();
    }
  } else {
    await expect(page.getByText(/^From /)).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /macOS Apple Silicon/i }),
    ).toHaveAttribute(
      "href",
      /^https:\/\/github\.com\/elizaOS\/eliza\/releases$/,
    );
    await expect(page.getByText("Opens release page").first()).toBeVisible();
  }
});
