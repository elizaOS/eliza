/**
 * Validates the store-facing endpoint pages (/privacy, /terms, /support) that
 * app-store reviewers depend on, plus the repo store-listing metadata that
 * references them. Deterministic file-content checks against the deployed
 * static assets — no network, no mocks.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const pages = {
  privacy: { file: "privacy.html", canonical: "https://elizaresearch.ai/privacy" },
  terms: { file: "terms.html", canonical: "https://elizaresearch.ai/terms" },
  support: { file: "support.html", canonical: "https://elizaresearch.ai/support" },
};

describe("store endpoint pages", () => {
  for (const [name, { file, canonical }] of Object.entries(pages)) {
    describe(name, () => {
      const html = read(`./${file}`);

      it("is a complete standalone document with a canonical URL", () => {
        expect(html).toMatch(/^<!doctype html>/u);
        expect(html).toContain(`<link rel="canonical" href="${canonical}" />`);
        expect(html).toContain('<html lang="en">');
        expect(html).toContain("</html>");
        expect(html).toContain('<meta name="viewport"');
      });

      it("loads no scripts and no cross-origin resources", () => {
        expect(html).not.toContain("<script");
        const externalRefs = [...html.matchAll(/(?:src|url\()\s*\(?["']?(https?:)?\/\//gu)];
        expect(externalRefs).toEqual([]);
      });

      it("cross-links the other endpoint pages and home", () => {
        expect(html).toContain('href="/"');
        for (const other of Object.keys(pages).filter((p) => p !== name)) {
          expect(html).toContain(`href="/${other}"`);
        }
      });
    });
  }

  it("privacy names the account/data-deletion path and privacy contact", () => {
    const html = read("./privacy.html");
    expect(html).toContain('id="account-deletion"');
    expect(html).toContain("mailto:privacy@elizaresearch.ai");
    expect(html).toMatch(/Last updated:/u);
  });

  it("terms carries the load-bearing legal sections", () => {
    const html = read("./terms.html");
    for (const id of ["your-content", "ai-output", "disclaimer", "governing-law", "contact"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("MIT License");
  });

  it("support names a company-controlled contact and response path", () => {
    const html = read("./support.html");
    expect(html).toContain("mailto:support@elizaresearch.ai");
    expect(html).toMatch(/respond within/u);
    expect(html).toContain("github.com/elizaOS/eliza/issues");
    expect(html).toContain("security/advisories/new");
  });

  it("home page links every endpoint page", () => {
    const html = read("./index.html");
    for (const name of Object.keys(pages)) {
      expect(html).toContain(`href="/${name}"`);
    }
  });
});

describe("store listing metadata references the canonical endpoints", () => {
  const repoRoot = new URL("../../", import.meta.url);
  const readRepo = (relative) => readFileSync(new URL(relative, repoRoot), "utf8");

  it("MSIX Partner Center listing uses elizaresearch.ai support/privacy URLs", () => {
    const listing = JSON.parse(
      readRepo("packages/app-core/packaging/msix/store/listing.json"),
    );
    expect(listing.listing.supportUrl).toBe("https://elizaresearch.ai/support");
    expect(listing.listing.privacyUrl).toBe("https://elizaresearch.ai/privacy");
  });

  it("iOS fastlane metadata uses elizaresearch.ai privacy/support URLs", () => {
    expect(
      readRepo("packages/app-core/platforms/ios/fastlane/metadata/en-US/privacy_url.txt").trim(),
    ).toBe("https://elizaresearch.ai/privacy");
    expect(
      readRepo("packages/app-core/platforms/ios/fastlane/metadata/en-US/support_url.txt").trim(),
    ).toBe("https://elizaresearch.ai/support");
  });

  it("Windows installer support URL is the canonical support endpoint", () => {
    expect(readRepo("packages/app-core/packaging/inno/ElizaOSApp.iss")).toContain(
      "AppSupportURL=https://elizaresearch.ai/support",
    );
  });

  it("no store metadata references the defunct elizaos-app repository", () => {
    for (const relative of [
      "packages/app-core/packaging/msix/store/listing.json",
      "packages/app-core/packaging/inno/ElizaOSApp.iss",
      "packages/app-core/packaging/flatpak/ai.elizaos.App.metainfo.xml",
    ]) {
      expect(readRepo(relative)).not.toContain("elizaos/elizaos-app");
    }
  });
});
