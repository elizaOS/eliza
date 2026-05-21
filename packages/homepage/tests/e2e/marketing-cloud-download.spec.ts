import { expect, type Locator, test } from "playwright/test";
import { releaseData } from "../../src/generated/release-data";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const primaryDownloadIds = [
  "macos-arm64",
  "macos-x64",
  "windows-x64",
  "linux-x64",
  "android-apk",
] as const;

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

async function expectReachableHead(label: string, href: string) {
  const response = await fetch(href, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  expect(
    response.status,
    `${label} should resolve without a broken external target: ${href}`,
  ).toBeLessThan(400);
}

test("homepage centers Eliza App downloads and product CTAs", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1").first()).toBeVisible({ timeout: 10_000 });

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

  const effectiveRelease =
    releaseData.release.downloads.length > 0
      ? releaseData.release
      : (releaseData.canaryRelease ?? releaseData.release);
  const effectiveDownloads = effectiveRelease.downloads;

  await expect(
    page
      .locator(".app-download-grid")
      .getByText(new RegExp(`From ${escapeRegExp(effectiveRelease.tagName)}`)),
  ).toHaveCount(primaryDownloadIds.length);

  if (effectiveDownloads.length === 0) {
    await expect(page.getByText("Opens release page")).toHaveCount(5);
    await expect(
      page.getByRole("link", {
        name: /macOS Apple Silicon|macOS \(Apple Silicon\)/i,
      }),
    ).toHaveAttribute(
      "href",
      /^https:\/\/github\.com\/elizaOS\/eliza\/releases$/,
    );
  }

  await expect(
    page.locator('.app-download-grid [aria-disabled="true"]'),
  ).toHaveCount(0);

  await expect(
    page.getByRole("heading", { name: /^Install elizaOS\.$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /^Install elizaOS$/ }).first(),
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

test("homepage live marketing links resolve for cloud, os, release, and downloads", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: /^Your Eliza, everywhere\.$/ }),
  ).toBeVisible();

  const links = page.locator("main a, header a, footer a");
  const hrefs = await links.evaluateAll((anchors) =>
    anchors
      .map((anchor) => ({
        label: anchor.textContent?.replace(/\s+/g, " ").trim() || "link",
        href: anchor.getAttribute("href"),
      }))
      .filter(
        (link): link is { label: string; href: string } =>
          Boolean(link.href) && link.href !== "#download",
      ),
  );

  const uniqueHrefs = new Map<string, string>();
  for (const link of hrefs) {
    const url = new URL(link.href, page.url());
    if (url.origin === new URL(page.url()).origin) {
      continue;
    }
    uniqueHrefs.set(url.toString(), link.label);
  }

  const cloudLinks = [...uniqueHrefs.keys()].filter((href) => {
    const url = new URL(href);
    return url.hostname.endsWith("elizacloud.ai");
  });
  expect(cloudLinks).toHaveLength(1);
  expect(new URL(cloudLinks[0]).pathname).toMatch(/^\/login\/?$/);
  expect(new URL(cloudLinks[0]).searchParams.get("intent")).toBe("launch");

  const effectiveRelease =
    releaseData.release.downloads.length > 0
      ? releaseData.release
      : (releaseData.canaryRelease ?? releaseData.release);
  const downloadTargets =
    effectiveRelease.downloads.length > 0
      ? effectiveRelease.downloads
          .filter((download) =>
            primaryDownloadIds.includes(
              download.id as (typeof primaryDownloadIds)[number],
            ),
          )
          .map((download) => download.url)
      : ["https://github.com/elizaOS/eliza/releases"];
  const osArtifactTargets = releaseData.osArtifacts
    .map((artifact) => artifact.downloadUrl)
    .filter((href): href is string => Boolean(href));
  const expectedNonCloudTargets = [
    "https://elizaos.ai/",
    releaseData.release.url,
    releaseData.release.checksum?.url,
    ...downloadTargets,
    ...osArtifactTargets,
  ].filter((href): href is string => Boolean(href));

  const nonCloudHrefs = [...uniqueHrefs.keys()].filter(
    (href) => !new URL(href).hostname.endsWith("elizacloud.ai"),
  );
  expect(nonCloudHrefs.sort()).toEqual(expectedNonCloudTargets.sort());

  for (const [href, label] of uniqueHrefs) {
    await expectReachableHead(label, href);
  }
});
