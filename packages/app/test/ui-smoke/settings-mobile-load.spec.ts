// Mobile load coverage for every settings section. The user reported that some
// settings pages "just don't load because they have errors" at phone width.
// This spec opens each section at a 390x844 viewport against the keyless stub,
// captures uncaught exceptions + React error-boundary fallbacks, asserts the
// section body actually rendered, and writes a per-section verdict matrix to
// reports/settings-mobile-load/ so the failing sections are obvious.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  SETTINGS_SECTIONS,
  VIEWPORT_SIZES,
} from "../../../scripts/ai-qa/route-catalog.ts";
import { testOutputPath } from "../../../scripts/lib/test-output";
import {
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";

import { installCloudApiStubs } from "./helpers/cloud-audit-fixtures";
import { seedStewardSession } from "./helpers/test-auth";

const OUT_DIR = testOutputPath("app", "settings-mobile-load");

// Console errors that are expected against the keyless stub (an endpoint the
// stub does not implement returns 4xx/network error). These are NOT a "page
// failed to load" signal — only uncaught exceptions + error boundaries are.
const BENIGN_CONSOLE = [
  /Failed to load resource/i,
  /the server responded with a status/i,
  /net::ERR/i,
  /\b40[0-9]\b/,
  /\b50[0-9]\b/,
  /favicon/i,
];

function isBenign(message: string): boolean {
  return BENIGN_CONSOLE.some((pattern) => pattern.test(message));
}

test.describe("settings sections load at mobile width", () => {
  test.use({ viewport: VIEWPORT_SIZES.mobile });

  for (const section of SETTINGS_SECTIONS) {
    test(`${section.id} (${section.label}) renders without crashing`, async ({
      page,
    }) => {
      // Wallet & RPC is intentionally hidden until the Wallet capability is
      // enabled (SettingsView filters it when walletEnabled === false), so it
      // has no hub row against the keyless stub. Its body (WalletKeysSection +
      // ConfigPageView) is exercised by wallet-keys.spec.ts.
      test.skip(
        section.id === "wallet-rpc",
        "capability-gated; covered by wallet-keys.spec.ts",
      );
      await mkdir(OUT_DIR, { recursive: true });

      const uncaught: string[] = [];
      const consoleErrors: string[] = [];
      page.on("pageerror", (error) => {
        uncaught.push(error.stack ?? error.message);
      });
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (isBenign(text)) return;
        consoleErrors.push(text);
      });

      await seedAppStorage(page, { "eliza:developerMode": "1" });
      await installDefaultAppRoutes(page);
      await openAppPath(page, "/settings");

      let navError: string | null = null;
      try {
        await openSettingsSection(page, section.match);
      } catch (error) {
        navError = (error as Error).message;
      }

      // Let async section bodies fetch + paint.
      await page.waitForTimeout(800);

      const sectionRoot = page.locator(`#${section.id}`).first();
      const sectionVisible = await sectionRoot.isVisible().catch(() => false);

      const boundaryHit = await page
        .locator(
          '[data-testid="settings-section-error"], [data-testid="cloud-route-error-fallback"]',
        )
        .first()
        .isVisible()
        .catch(() => false);

      const bodyText = await page
        .locator("[data-testid='settings-shell']")
        .first()
        .innerText()
        .catch(() => "");

      const verdict = {
        id: section.id,
        label: section.label,
        navError,
        sectionVisible,
        boundaryHit,
        uncaught,
        consoleErrors,
        bodyChars: bodyText.trim().length,
      };
      await writeFile(
        join(OUT_DIR, `${section.id}.json`),
        `${JSON.stringify(verdict, null, 2)}\n`,
      );
      await page
        .screenshot({
          path: join(OUT_DIR, `${section.id}.png`),
          fullPage: true,
        })
        .catch(() => {});

      // A section "loads" when: navigation reached it, its root is visible, no
      // error-boundary fallback rendered, and no uncaught exception fired.
      expect(uncaught, `${section.id}: uncaught exception(s)`).toEqual([]);
      expect(boundaryHit, `${section.id}: rendered an error boundary`).toBe(
        false,
      );
      expect(
        navError,
        `${section.id}: could not navigate to section`,
      ).toBeNull();
      expect(
        sectionVisible,
        `${section.id}: section root #${section.id} never became visible`,
      ).toBe(true);
      expect(consoleErrors, `${section.id}: non-benign console errors`).toEqual(
        [],
      );
    });
  }
});

// Cloud sections are registered separately from the local route catalog.
// Exercise their legacy hashes with a signed-in fixture, checking either the
// embedded section or the canonical Cloud route body after redirection.
const CLOUD_SECTION_IDS = [
  "cloud-agents",
  "cloud-account",
  "cloud-billing",
  "cloud-organization",
  "cloud-connectors",
  "mcps",
  "cloud-security",
  "cloud-plugin-grants",
] as const;

const DEVELOPER_CLOUD_SECTION_IDS = [
  "cloud-api-keys",
  "cloud-applications",
  "cloud-monetization",
] as const;

const CLOUD_ROUTES: Record<
  string,
  {
    path: string;
    name: string;
    role?: "heading" | "button" | "link" | "tabpanel";
  }
> = {
  "cloud-account": { path: "/cloud/account", name: "Profile information" },
  "cloud-billing": { path: "/cloud/billing", name: "Credit Balance" },
  "cloud-api-keys": {
    path: "/cloud/api-keys",
    name: "Generate key",
    role: "button",
  },
  "cloud-applications": {
    path: "/cloud/apps",
    name: "Smoke App",
    role: "link",
  },
  "cloud-monetization": {
    path: "/cloud/monetization",
    name: "Earnings",
    role: "tabpanel",
  },
  "cloud-organization": { path: "/cloud/organization", name: "Smoke Org" },
  "cloud-plugin-grants": {
    path: "/cloud/security/permissions",
    name: "Active grants",
  },
};

test.describe("cloud settings sections load at mobile width", () => {
  test.use({ viewport: VIEWPORT_SIZES.mobile });

  for (const { id, developerMode, viewport } of [
    ...CLOUD_SECTION_IDS.map((id) => ({
      id,
      developerMode: false,
      viewport: VIEWPORT_SIZES.mobile,
    })),
    ...DEVELOPER_CLOUD_SECTION_IDS.map((id) => ({
      id,
      developerMode: true,
      viewport: VIEWPORT_SIZES.mobile,
    })),
    { id: "mcps", developerMode: false, viewport: VIEWPORT_SIZES.desktop },
  ] as const) {
    test(`${id} renders without crashing at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await mkdir(OUT_DIR, { recursive: true });

      const uncaught: string[] = [];
      const consoleErrors: string[] = [];
      page.on("pageerror", (error) =>
        uncaught.push(error.stack ?? error.message),
      );
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (isBenign(text)) return;
        consoleErrors.push(text);
      });

      await seedAppStorage(
        page,
        developerMode ? { "eliza:developerMode": "1" } : {},
      );
      await installDefaultAppRoutes(page);
      await installCloudApiStubs(page);
      await seedStewardSession(page, { jwt: true });
      await openAppPath(page, "/settings");

      // Legacy hashes either select an embedded section or redirect to the
      // canonical authenticated Cloud route; verify that route body renders.
      await page.evaluate((sectionId) => {
        window.location.hash = `#${sectionId}`;
      }, id);

      const destination = CLOUD_ROUTES[id];
      if (destination) {
        await expect(page).toHaveURL(new RegExp(`${destination.path}$`));
      }
      const sectionRoot = destination
        ? page
            .getByRole(destination.role ?? "heading", {
              name: destination.name,
              exact: true,
            })
            .first()
        : page.locator(`#${id}`).first();
      const sectionVisible = await sectionRoot
        .waitFor({ state: "visible", timeout: 30_000 })
        .then(() => true)
        .catch(() => false);
      await page.waitForTimeout(800);

      const boundaryHit = await page
        .locator(
          '[data-testid="settings-section-error"], [data-testid="cloud-route-error-fallback"]',
        )
        .first()
        .isVisible()
        .catch(() => false);

      const verdict = {
        id,
        sectionVisible,
        boundaryHit,
        uncaught,
        consoleErrors,
      };
      await writeFile(
        join(OUT_DIR, `${id}-${viewport.width}.json`),
        `${JSON.stringify(verdict, null, 2)}\n`,
      );
      await page
        .screenshot({
          path: join(OUT_DIR, `${id}-${viewport.width}.png`),
          fullPage: true,
        })
        .catch(() => {});

      expect(uncaught, `${id}: uncaught exception(s)`).toEqual([]);
      expect(boundaryHit, `${id}: rendered an error boundary`).toBe(false);
      expect(
        sectionVisible,
        `${id}: expected section or Cloud route body never became visible`,
      ).toBe(true);
      expect(consoleErrors, `${id}: non-benign console errors`).toEqual([]);
    });
  }
});
