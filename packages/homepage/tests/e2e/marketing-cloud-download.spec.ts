import { expect, test } from "playwright/test";
import { releaseData } from "../../src/generated/release-data";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("homepage exposes app downloads, stores, and cloud entrypoints", async ({
  page,
}) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: /^Your Eliza, everywhere\.$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /^Try Eliza Cloud$/ }),
  ).toHaveAttribute(
    "href",
    /^https:\/\/www\.elizacloud\.ai\/dashboard\/my-agents\/?$/,
  );
  await expect(
    page.getByRole("link", { name: /^Download the app$/ }).first(),
  ).toHaveAttribute("href", "#download");
  const productSwitcher = page.getByRole("navigation").first();
  await expect(
    productSwitcher.getByRole("link", { name: /^ElizaOS$/ }),
  ).toHaveAttribute("href", "https://elizaos.ai");
  await expect(
    productSwitcher.getByRole("link", { name: /^Eliza App$/ }),
  ).toHaveAttribute("href", "/");
  await expect(
    productSwitcher.getByRole("link", { name: /^Eliza Cloud$/ }),
  ).toHaveAttribute("href", /^https:\/\/www\.elizacloud\.ai\/?$/);
  await expect(page).toHaveTitle("Eliza App - Your Eliza, everywhere.");

  await expect(
    page.getByRole("heading", { name: /^Eliza Cloud$/ }),
  ).toBeVisible();
  await expect(
    page.getByText(/Hosted runtime, dashboard, API keys, billing/i),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Eliza Cloud.*Try Eliza Cloud/ }),
  ).toHaveAttribute(
    "href",
    /^https:\/\/www\.elizacloud\.ai\/dashboard\/my-agents\/?$/,
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
  }

  await expect(page.getByText(/^Start in chat\. Finish/)).toBeVisible();
  await expect(
    page.getByText(/Cloud provisions one personal agent/i),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Telegram.*Start onboarding/i }),
  ).toHaveAttribute("href", "/get-started?method=telegram");
  await expect(page.getByText(/One personal agent/i).first()).toBeVisible();
  await expect(page.getByText(/Execution plan/i)).toHaveCount(0);
  await expect(page.getByText(/should/i)).toHaveCount(0);

  if (releaseData.release.downloads.length > 0) {
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
