/**
 * Playwright coverage for marketing download CTAs and cloud/app link targets.
 */

import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import {
  type APIRequestContext,
  expect,
  type Locator,
  test,
} from "playwright/test";
import { releaseData } from "../../src/generated/release-data";

const RELEASES_URL = "https://github.com/elizaOS/eliza/releases";
const effectiveRelease = [
  releaseData.stableRelease,
  releaseData.canaryRelease,
  releaseData.release,
].find((release) => release && release.downloads.length > 0);
const effectiveReleaseUrl = effectiveRelease?.url ?? RELEASES_URL;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectCloudPath(locator: Locator) {
  const href = await locator.getAttribute("href");
  expect(href).toBeTruthy();
  const url = new URL(href ?? "", EXTERNAL_URLS.cloud);
  expect(url.origin).toBe(EXTERNAL_URLS.cloud);
  expect(url.pathname).toMatch(/^\/login\/?$/);
  expect(url.searchParams.get("intent")).toBe("launch");
}

async function expectWebAppPath(locator: Locator) {
  const href = await locator.getAttribute("href");
  expect(href).toBeTruthy();
  const url = new URL(href ?? "", EXTERNAL_URLS.app);
  expect(url.origin).toBe(EXTERNAL_URLS.app);
  expect(url.pathname).toMatch(/^\/?$/);
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

async function expectReachableHead(
  request: APIRequestContext,
  label: string,
  href: string,
) {
  const response = await request.fetch(href, {
    method: "HEAD",
    maxRedirects: 5,
    timeout: 20_000,
  });
  expect(
    response.status(),
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

  await expect(page).toHaveTitle("Eliza | The agent that belongs to you");
  await expect(
    page.getByRole("heading", {
      name: /^The agent that runs your life should belong to you\.$/,
    }),
  ).toBeVisible();

  const productNav = page.getByRole("navigation", {
    name: "Eliza products",
  });
  await expectWebAppPath(productNav.getByRole("link", { name: /^Web app$/ }));
  await expect(
    productNav.getByRole("link", { name: /^Downloads$/ }),
  ).toHaveAttribute("href", "#download");
  await expectCloudPath(productNav.getByRole("link", { name: /^Cloud$/ }));

  await expect(
    page.getByRole("link", { name: /^Download$/ }).first(),
  ).toHaveAttribute("href", "#download");
  await expectWebAppPath(
    page.getByRole("link", { name: /^Open web app$/ }).first(),
  );
  await expectCloudPath(
    page.getByRole("link", { name: /^Try Eliza Cloud$/ }).first(),
  );

  await page
    .getByRole("link", { name: /^Download$/ })
    .first()
    .click();
  await expect(page).toHaveURL(/#download$/);
  await expect(
    page.getByRole("heading", { name: /^Eliza goes where you go\.$/ }),
  ).toBeVisible();

  await expect(
    page.getByRole("link", { name: /macOS \(Apple Silicon\)/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /macOS \(Intel\)/i }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Windows/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /Linux/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /Android APK/i })).toBeVisible();

  const effectiveDownloads = effectiveRelease?.downloads ?? [];

  await expect(
    page.getByText(
      new RegExp(
        `From ${escapeRegExp(effectiveRelease?.tagName ?? "unavailable")}`,
      ),
    ),
  ).toHaveCount(effectiveDownloads.length);

  if (effectiveDownloads.length === 0) {
    const primaryDownloadCards = page.locator(".life-download-grid a");
    await expect(page.getByText("Opens release page")).toHaveCount(
      await primaryDownloadCards.count(),
    );
    await expect(
      page.getByRole("link", {
        name: /macOS Apple Silicon|macOS \(Apple Silicon\)/i,
      }),
    ).toHaveAttribute("href", RELEASES_URL);
    await expect(
      page.getByRole("link", { name: "View releases" }),
    ).toHaveAttribute("href", RELEASES_URL);
  }

  // The primary app-download-grid must not contain disabled cards. The
  // separate osArtifact grid may contain pending entries (rendered with
  // aria-disabled="true") for distributions still in build.
  await expect(
    page.locator('.life-download-grid [aria-disabled="true"]'),
  ).toHaveCount(0);

  await expect(
    page.getByRole("heading", { name: /^elizaOS artifacts$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /^Install elizaOS$/ }).first(),
  ).toHaveAttribute("href", EXTERNAL_URLS.os);
  await expect(
    page.getByRole("heading", { name: /Everyone else rents you an assistant/ }),
  ).toBeVisible();
  await expectCloudPath(
    page.getByRole("link", { name: /^Try Eliza Cloud$/ }).last(),
  );

  await expect(page.locator(".life-site")).toHaveCSS(
    "font-family",
    "Poppins, system-ui, sans-serif",
  );
  await expect(page.locator(".life-hero")).toHaveCSS("border-radius", "0px");
});

test("homepage live marketing links resolve for cloud, os, release, and downloads", async ({
  page,
  request,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", {
      name: /^The agent that runs your life should belong to you\.$/,
    }),
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

  const appLinks = [...uniqueHrefs.keys()].filter((href) => {
    const url = new URL(href);
    return url.origin === EXTERNAL_URLS.app;
  });
  expect(appLinks).toEqual([`${EXTERNAL_URLS.app}/`]);

  const cloudLinks = [...uniqueHrefs.keys()].filter((href) => {
    const url = new URL(href);
    return url.origin === EXTERNAL_URLS.cloud;
  });
  expect(cloudLinks).toHaveLength(1);
  expect(new URL(cloudLinks[0]).pathname).toMatch(/^\/login\/?$/);
  expect(new URL(cloudLinks[0]).searchParams.get("intent")).toBe("launch");

  const downloadTargets =
    effectiveRelease && effectiveRelease.downloads.length > 0
      ? effectiveRelease.downloads.map((download) => download.url)
      : [RELEASES_URL];
  // osArtifacts with a downloadUrl render as anchor tags too, so include them.
  const osArtifactUrls = releaseData.osArtifacts
    .map((artifact) => artifact.downloadUrl)
    .filter((url): url is string => Boolean(url));

  const expectedNonCloudTargets = Array.from(
    new Set(
      [
        `${EXTERNAL_URLS.os}/`,
        effectiveReleaseUrl,
        effectiveRelease?.checksum?.url,
        ...downloadTargets,
        ...osArtifactUrls,
      ].filter((href): href is string => Boolean(href)),
    ),
  );

  const nonCloudHrefs = [...uniqueHrefs.keys()].filter(
    (href) =>
      !["app.elizacloud.ai", "elizacloud.ai", "www.elizacloud.ai"].includes(
        new URL(href).hostname,
      ),
  );
  expect(nonCloudHrefs.sort()).toEqual(expectedNonCloudTargets.sort());

  for (const [href, label] of uniqueHrefs) {
    await expectReachableHead(request, label, href);
  }
});
