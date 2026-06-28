import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARDWARE_PRODUCTS } from "@elizaos/shared/hardware-catalog";
import {
  type APIRequestContext,
  expect,
  type Locator,
  test,
} from "playwright/test";

type ReleaseArtifact = {
  id: string;
  label: string;
  url: string;
  checksumUrl?: string;
};

type ReleaseManifest = {
  artifacts: ReleaseArtifact[];
};

const testDir = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(
    join(testDir, "..", "public", "downloads", "elizaos-beta-manifest.json"),
    "utf8",
  ),
) as ReleaseManifest;

async function href(locator: Locator) {
  const value = await locator.getAttribute("href");
  expect(value).toBeTruthy();
  return value as string;
}

async function expectReachable(
  request: APIRequestContext,
  label: string,
  target: string,
) {
  const head = await request.fetch(target, {
    method: "HEAD",
    maxRedirects: 5,
    timeout: 20_000,
  });
  const response =
    head.status() === 405
      ? await request.get(target, { maxRedirects: 5, timeout: 20_000 })
      : head;
  expect(
    response.status(),
    `${label} should resolve without a broken live target: ${target}`,
  ).toBeLessThan(400);
}

test.describe("live elizaOS marketing and hardware link integrity", () => {
  test("home page download, product, cloud, and app links match live targets", async ({
    page,
    request,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /The agentic operating system/i }),
    ).toBeVisible();

    const downloadSection = page.locator("#download");
    await expect(downloadSection).toBeVisible();

    const liveTargets = new Map<string, string>();
    for (const artifact of manifest.artifacts) {
      const card = downloadSection.locator(".release-item", {
        hasText: artifact.label,
      });
      await expect(card).toBeVisible();
      await expect(
        card.getByRole("link", { name: "Download" }),
      ).toHaveAttribute("href", artifact.url);
      liveTargets.set(artifact.url, `${artifact.label} download`);

      if (artifact.checksumUrl) {
        await expect(
          card.getByRole("link", { name: "SHA256" }),
        ).toHaveAttribute("href", artifact.checksumUrl);
        liveTargets.set(artifact.checksumUrl, `${artifact.label} checksum`);
      }
    }

    const hardwareSection = page.locator("#hardware");
    await expect(hardwareSection).toBeVisible();
    await expect(
      hardwareSection.getByRole("link", { name: /Open checkout/i }),
    ).toHaveAttribute("href", "/checkout?collection=elizaos-hardware");
    const collectionCheckout = await page.request.get(
      "/checkout?collection=elizaos-hardware",
    );
    expect(collectionCheckout.status()).toBeLessThan(400);

    for (const product of HARDWARE_PRODUCTS) {
      const productLink = hardwareSection.locator(
        `a.hw-tile[href="/hardware/${product.slug}"]`,
      );
      await expect(productLink).toBeVisible();
    }

    const footer = page.locator("footer.site-footer");
    await expect(footer.getByRole("link", { name: "App" })).toHaveAttribute(
      "href",
      "https://elizaos.ai",
    );
    await expect(footer.getByRole("link", { name: "Cloud" })).toHaveAttribute(
      "href",
      /https:\/\/(www\.)?elizacloud\.ai\/login\?intent=launch/,
    );
    liveTargets.set("https://elizaos.ai", "Eliza app");
    liveTargets.set("https://elizacloud.ai/login?intent=launch", "Eliza Cloud");

    for (const [target, label] of liveTargets) {
      await expectReachable(request, label, target);
    }
  });

  for (const product of HARDWARE_PRODUCTS) {
    test(`hardware detail live links resolve for ${product.name}`, async ({
      page,
    }) => {
      await page.goto(`/hardware/${product.slug}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(
        page.getByRole("heading", { level: 1, name: product.name }),
      ).toBeVisible();

      const preorder = await href(
        page.getByRole("link", { name: /Pre-order checkout/i }),
      );
      expect(preorder).toBe(`/checkout?sku=${product.sku}`);

      const beta = await href(
        page.getByRole("link", { name: /Download beta/i }),
      );
      expect(beta).toBe("/downloads/elizaos-beta-manifest.json");

      const checkoutResponse = await page.request.get(preorder);
      expect(checkoutResponse.status()).toBeLessThan(400);
      const manifestResponse = await page.request.get(beta);
      expect(manifestResponse.status()).toBeLessThan(400);
      const body = (await manifestResponse.json()) as ReleaseManifest;
      expect(body.artifacts.map((artifact) => artifact.id).sort()).toEqual(
        manifest.artifacts.map((artifact) => artifact.id).sort(),
      );
    });
  }
});
