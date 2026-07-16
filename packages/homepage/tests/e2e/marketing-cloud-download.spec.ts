/**
 * Playwright coverage for marketing download CTAs and cloud/app link targets.
 */

import {
  type APIRequestContext,
  expect,
  type Locator,
  test,
} from "playwright/test";
import { releaseData } from "../../src/generated/release-data";
import { selectEffectiveRelease } from "../../src/lib/release-selection";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

test("homepage ports the sovereign OG surface and preserves downloads", async ({
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

  await expect(page).toHaveTitle("elizaOS: the OS for sovereign agent devices");
  await expect(
    page.getByRole("heading", {
      name: /^The OS for sovereign agent devices\.$/,
    }),
  ).toBeVisible();
  await expect(page.getByText("Open source").first()).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: /Everyone built a gadget\. We build the layer underneath\./,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /^The Linux of agent devices\.$/ }),
  ).toBeVisible();

  await expect(
    page.getByRole("link", { name: /^The deal ↓$/ }),
  ).toHaveAttribute("href", "#deal");
  await expect(
    page.getByRole("link", { name: /^How it works$/ }),
  ).toHaveAttribute("href", "#stack");
  await expect(
    page.getByRole("link", { name: /^Download$/ }).first(),
  ).toHaveAttribute("href", "#download");

  await expect(
    page.getByRole("link", { name: /^Read the Orange Paper →$/ }),
  ).toHaveAttribute("href", "/orange-paper");
  await expect(
    page.getByRole("link", { name: /^github\.com\/elizaOS$/ }).first(),
  ).toHaveAttribute("href", "https://github.com/elizaOS/eliza");

  await page.goto("/orange-paper", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: /^Own your intelligence\.$/ }),
  ).toBeVisible();
  await expect(page).toHaveTitle("elizaOS: the Orange Paper");

  await page.goto("/plan", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: /^Own your intelligence\.$/ }),
  ).toBeVisible();

  await page.goto("/", { waitUntil: "domcontentloaded" });
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

  const effectiveRelease = selectEffectiveRelease(releaseData);
  const effectiveDownloads = effectiveRelease.downloads;

  await expect(
    page.getByText(
      new RegExp(`From ${escapeRegExp(effectiveRelease.tagName)}`),
    ),
  ).toHaveCount(effectiveDownloads.length);

  if (effectiveDownloads.length === 0) {
    const primaryDownloadCards = page.locator(
      '[data-testid="download-grid"] a',
    );
    await expect(page.getByText("Opens release page")).toHaveCount(
      await primaryDownloadCards.count(),
    );
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
    page.locator('[data-testid="download-grid"] [aria-disabled="true"]'),
  ).toHaveCount(0);

  const availableOsArtifacts = releaseData.osArtifacts.filter(
    (artifact) => artifact.downloadUrl,
  );
  const osArtifactLinks = page.locator(
    '[data-testid="os-artifact-list"] a[data-os-artifact-id]',
  );
  await expect(osArtifactLinks).toHaveCount(availableOsArtifacts.length);
  for (const artifact of availableOsArtifacts) {
    await expect(
      page.locator(`[data-os-artifact-id="${artifact.id}"]`),
    ).toHaveAttribute("href", artifact.downloadUrl ?? "");
  }

  await expect(page.locator(".sovereign-page")).toHaveCSS(
    "font-family",
    /Poppins/,
  );
  await expect(page.locator(".sovereign-section").first()).toHaveCSS(
    "border-radius",
    "0px",
  );
});

test("homepage live marketing links resolve for cloud, os, release, and downloads", async ({
  page,
  request,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", {
      name: /^The OS for sovereign agent devices\.$/,
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

  const effectiveRelease = selectEffectiveRelease(releaseData);
  const downloadTargets =
    effectiveRelease.downloads.length > 0
      ? effectiveRelease.downloads.map((download) => download.url)
      : ["https://github.com/elizaOS/eliza/releases"];
  const osArtifactDownloadTargets = releaseData.osArtifacts
    .map((artifact) => artifact.downloadUrl)
    .filter((href): href is string => Boolean(href));
  const osArtifactSupplementalTargets = releaseData.osArtifacts
    .flatMap((artifact) => [artifact.checksumUrl, artifact.releaseNotesUrl])
    .filter((href): href is string => Boolean(href));
  const expectedNonCloudTargets = Array.from(
    new Set(
      [
        "https://github.com/elizaOS/eliza",
        effectiveRelease.url,
        effectiveRelease.checksum?.url,
        ...downloadTargets,
        ...osArtifactDownloadTargets,
        ...osArtifactSupplementalTargets,
      ].filter((href): href is string => Boolean(href)),
    ),
  );

  expect([...uniqueHrefs.keys()].sort()).toEqual(
    expectedNonCloudTargets.sort(),
  );

  for (const [href, label] of uniqueHrefs) {
    await expectReachableHead(request, label, href);
  }

  for (const href of osArtifactDownloadTargets) {
    await expectReachableHead(request, "OS artifact", href);
  }
});
