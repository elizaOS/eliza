import { expect, test } from "@playwright/test";
import { releaseData } from "../../src/generated/release-data";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("homepage exposes downloads and Eliza Cloud web app entrypoints", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /^Eliza$/ })).toBeVisible();
  await expect(
    page.getByRole("link", { name: /^Open in Cloud$/ }),
  ).toHaveAttribute("href", /^https:\/\/www\.elizacloud\.ai\/?$/);
  await expect(
    page.getByRole("link", { name: /^Download$/ }),
  ).toHaveAttribute("href", "#download");

  await expect(
    page.getByRole("heading", { name: /^Eliza Cloud$/ }),
  ).toBeVisible();
  await expect(
    page.getByText(/web version of the app connected to a cloud agent/i),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /^Use the web app$/ }),
  ).toHaveAttribute("href", /^https:\/\/www\.elizacloud\.ai\/?$/);

  await page.getByRole("link", { name: /^Download$/ }).click();
  await expect(page).toHaveURL(/#download$/);
  await expect(page.getByRole("heading", { name: /^Download$/ })).toBeVisible();
  await expect(
    page.getByRole("link", { name: /macOS Apple Silicon/i }),
  ).toHaveAttribute("href", /releases\/latest\/download|github\.com/);
  await expect(page.getByRole("link", { name: /^Windows/i })).toHaveAttribute(
    "href",
    /releases\/latest\/download|github\.com/,
  );
  await expect(page.getByRole("link", { name: /AppImage|Tarball/i }).first())
    .toHaveAttribute("href", /releases\/latest\/download|github\.com/);

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
  }
});
