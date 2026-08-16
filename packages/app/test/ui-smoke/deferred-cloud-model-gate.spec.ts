/**
 * Browser regression for a local desktop whose configured Eliza Cloud text
 * provider registers after the home composer has already mounted.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  expectNoPageDiagnostics,
  installDefaultAppRoutes,
  installPageDiagnosticsGuard,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.describe("deferred Eliza Cloud model registration", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  for (const surface of [
    { name: "desktop", viewport: { width: 1440, height: 900 } },
    { name: "mobile", viewport: { width: 390, height: 844 } },
  ] as const) {
    test(`${surface.name} releases the stale local-model gate without a reload`, async ({
      page,
    }) => {
      await page.setViewportSize(surface.viewport);
      await installDefaultAppRoutes(page);
      await seedAppStorage(page);

      let cloudRegistered = false;
      let modelConfigReads = 0;

      await page.route("**/api/config", async (route) => {
        if (route.request().method() !== "GET") {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            meta: { firstRunComplete: true },
            serviceRouting: {
              llmText: { backend: "elizacloud", transport: "cloud-proxy" },
            },
          }),
        });
      });

      await page.route("**/api/models/config", async (route) => {
        if (route.request().method() !== "GET") {
          await route.fallback();
          return;
        }
        modelConfigReads += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            cloudRegistered
              ? {
                  activeChat: {
                    provider: "elizacloud",
                    family: "ELIZAOS_CLOUD",
                    endpoint: "https://api.eliza.app/v1",
                  },
                }
              : { targets: { small: {}, large: {}, coding: {} } },
          ),
        });
      });

      await page.route("**/api/local-inference/hub", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            textReadiness: {
              slots: {
                TEXT_SMALL: {
                  slot: "TEXT_SMALL",
                  assigned: true,
                  assignedModelId: "eliza-1-2b",
                  displayName: "Eliza 1 2B",
                  primaryDownloaded: false,
                  downloaded: false,
                  active: false,
                  ready: false,
                  state: "missing",
                  requiredModelIds: ["eliza-1-2b"],
                  missingModelIds: ["eliza-1-2b"],
                  installedBytes: 0,
                  expectedBytes: 0,
                  download: {
                    state: "missing",
                    receivedBytes: 0,
                    totalBytes: 0,
                    percent: null,
                    bytesPerSec: 0,
                    etaMs: null,
                    updatedAt: null,
                    errors: [],
                  },
                  errors: [],
                },
              },
            },
          }),
        });
      });

      await page.route(
        "**/api/local-inference/downloads/stream**",
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: "",
          });
        },
      );

      await openAppPath(page, "/chat");

      const composer = page.getByTestId("chat-composer-textarea");
      await expect(composer).toHaveAttribute(
        "placeholder",
        /Getting Eliza 1 2B ready/i,
        {
          timeout: 30_000,
        },
      );
      await page.getByRole("button", { name: "drag up to open chat" }).click();
      await expect(composer).toBeEnabled();

      const captureDir = path.join(
        process.cwd(),
        "aesthetic-audit-output",
        "deferred-cloud-model-gate",
      );
      mkdirSync(captureDir, { recursive: true });
      await page.screenshot({
        path: path.join(captureDir, `${surface.name}-before.png`),
        fullPage: true,
      });

      cloudRegistered = true;

      await expect(composer).not.toHaveAttribute(
        "placeholder",
        /Getting .* ready/i,
      );
      await expect(composer).toBeEnabled();
      expect(modelConfigReads).toBeGreaterThanOrEqual(2);
      await page.screenshot({
        path: path.join(captureDir, `${surface.name}-after.png`),
        fullPage: true,
      });
    });
  }
});
