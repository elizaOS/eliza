/**
 * Rendered UI-smoke evidence for PR #17572 — the interactive Cloud login
 * call-site contract (#17129).
 *
 * The PR split the Cloud login entry points: interactive surfaces must go
 * through `handleInteractiveCloudLogin` (which pre-opens the named popup via
 * `preOpenCloudLoginWindow` → `window.open("about:blank", "eliza-cloud-auth")`),
 * while the raw null-window path is only reachable through the separately named
 * `handleCloudLoginRecovery` at the two sanctioned boot sites. This spec proves
 * the RENDERED path is the interactive one: from the real Settings → Cloud
 * surface, clicking the connect CTA opens a real popup window named
 * `eliza-cloud-auth` — the exact behavior the type-level contract protects —
 * with before/after screenshots, a video walkthrough, and raw console/network
 * logs captured at the exact PR head.
 *
 * The cloud API is stubbed at the network boundary (the established ui-smoke
 * pattern); the renderer, store, call-site wiring, and popup open are the real
 * production modules. `preOpenWindow` runs in this test environment because the
 * page is a plain web platform (not Electrobun/Capacitor), has no same-origin
 * Steward login on 127.0.0.1, and headless Chromium is not touch-primary — so
 * the interactive path pre-opens the popup instead of falling to same-tab.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
  hideChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  openSettingsSection,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

const CLOUD_LOGIN_POPUP_NAME = "eliza-cloud-auth";
const CLOUD_AUTH_TOKEN = "ui-smoke-cloud-login-callsite-token";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

async function screenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.jpg`);
  await mkdir(testInfo.outputDir, { recursive: true });
  await captureScreenshotWithQualityRetry(page, name, {
    path: screenshotPath,
    type: "jpeg",
    quality: 90,
    fullPage: false,
    attempts: 4,
  });
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/jpeg",
  });
}

/** Install the cloud-login endpoint stubs the interactive flow needs. */
async function installCloudLoginRoutes(page: Page): Promise<void> {
  await page.route("**/api/cloud/login", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        sessionId: "ui-smoke-callsite-session",
        browserUrl:
          "https://www.elizacloud.ai/device/ui-smoke-callsite-session",
      }),
    });
  });
  // Serve a real-ish device page so the popup renders content instead of a
  // network error (sandbox has no outbound network). The flow navigates the
  // pre-opened popup to the login/device URL, which the stubbed /api/cloud/login
  // response addresses on the www host. Context-scoped: page routes do not
  // apply to the popup, which is a separate Page.
  await page
    .context()
    .route(/^https:\/\/(www\.)?elizacloud\.ai\//, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><html><head><title>Eliza Cloud login (ui-smoke stub)</title></head>
<body style="font-family:system-ui;background:#0f1115;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><h1>Eliza Cloud</h1><p>Device login (ui-smoke evidence stub)</p>
<p style="color:#8b949e;font-size:12px">window.name = eliza-cloud-auth</p></div></body></html>`,
      });
    });
}

async function bootCloudSettings(
  page: Page,
  size: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(size);
  await seedAppStorage(page);
  // Since 630ea3396a SettingsView hides `cloudOnly` sections unless the boot
  // resolves a managed Cloud runtime, and the shared seed pins a LOCAL active
  // server. This spec exercises the Cloud group's connect CTA, so persist a
  // cloud-kind server (same-origin apiBase keeps the mocked surface serving);
  // runs after seedAppStorage so this key wins over the local default.
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        "elizaos:active-server",
        JSON.stringify({
          id: "cloud:personal:11111111-1111-5111-8111-111111111111",
          kind: "cloud",
          label: "Eliza Cloud",
          apiBase: location.origin,
          cloudRuntimeAgentId: "22222222-2222-4222-8222-222222222222",
          cloudRuntime: "dedicated",
        }),
      );
    } catch {
      // Sandboxed frames can deny storage; the shell frame is what matters.
    }
  });
  await installDefaultAppRoutes(page);
  await installCloudLoginRoutes(page);
  // The chat overlay boots open at the half detent and its message scroller
  // sits over the settings hub rows on the mobile viewport, swallowing the
  // Overview click (the established ui-smoke pattern for non-chat surfaces).
  await hideChatOverlay(page);
  await openAppPath(page, "/settings");
  // The Cloud overview section is the "Overview" entry under the Cloud
  // heading in the settings hub; it hosts the connect CTA.
  await openSettingsSection(page, "Overview");
  // The connect CTA mounts once the Cloud overview section renders.
  await expect(
    page.getByRole("button", { name: /Connect (Eliza )?Cloud/ }).first(),
  ).toBeVisible({ timeout: 60_000 });
}

test.describe("cloud login callsite — interactive popup opens from the real Settings CTA (#17129)", () => {
  for (const viewport of VIEWPORTS) {
    test(`clicking the connect CTA opens the eliza-cloud-auth popup on ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      const consoleLogs: string[] = [];
      const networkLogs: string[] = [];
      page.on("console", (message) => {
        consoleLogs.push(`[${message.type()}] ${message.text()}`);
      });
      page.on("pageerror", (error) => {
        consoleLogs.push(`[pageerror] ${error.message}`);
      });
      page.on("request", (request) => {
        if (
          request.url().includes("/api/cloud/") ||
          request.url().includes("elizacloud.ai")
        ) {
          networkLogs.push(`REQ ${request.method()} ${request.url()}`);
        }
      });
      page.on("response", (response) => {
        if (
          response.url().includes("/api/cloud/") ||
          response.url().includes("elizacloud.ai")
        ) {
          networkLogs.push(`RES ${response.status()} ${response.url()}`);
        }
      });

      await bootCloudSettings(page, viewport);
      await screenshot(page, testInfo, `${viewport.name}-1-before-connect-cta`);

      // The interactive path must open a REAL popup named eliza-cloud-auth.
      const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
      await page
        .getByRole("button", { name: /Connect (Eliza )?Cloud/ })
        .first()
        .click();
      const popup = await popupPromise;

      // The popup navigates to the device-login URL on the direct cloud base
      // (stubbed above) — proving the interactive path drives the popup to the
      // real login URL instead of falling back to same-tab. Settle this FIRST:
      // evaluating during the about:blank → device-URL navigation races the
      // context teardown ("Execution context was destroyed").
      await expect
        .poll(
          async () => {
            const url = popup.url();
            return url.includes("elizacloud.ai/") ? url : "";
          },
          { timeout: 15_000 },
        )
        .not.toBe("");
      // window.open("about:blank", "eliza-cloud-auth") — assert the name,
      // which persists across navigations on the same window. Poll with a
      // swallowed evaluate: any still-committing navigation destroys the
      // execution context mid-call, and the poll simply retries on the next
      // stable document.
      let popupName: string | null = null;
      await expect
        .poll(
          async () => {
            popupName = await popup
              .evaluate(() => window.name)
              .catch(() => null);
            return popupName;
          },
          { timeout: 15_000 },
        )
        .toBe(CLOUD_LOGIN_POPUP_NAME);
      await popup.screenshot({
        path: testInfo.outputPath(`${viewport.name}-popup-device-login.png`),
        type: "png",
      });
      await testInfo.attach(`${viewport.name}-popup-device-login`, {
        path: testInfo.outputPath(`${viewport.name}-popup-device-login.png`),
        contentType: "image/png",
      });

      await screenshot(page, testInfo, `${viewport.name}-2-after-popup-opened`);

      // Raw console + network logs as reviewable artifacts.
      const logsPath = testInfo.outputPath(
        `${viewport.name}-console-network.log`,
      );
      await mkdir(testInfo.outputDir, { recursive: true });
      await writeFile(
        logsPath,
        `=== console (${consoleLogs.length}) ===\n${consoleLogs.join("\n")}\n\n=== cloud network (${networkLogs.length}) ===\n${networkLogs.join("\n")}\n`,
        "utf8",
      );
      await testInfo.attach(`${viewport.name}-console-network-logs`, {
        path: logsPath,
        contentType: "text/plain",
      });

      // The interactive call must NOT have used the recovery/null-window path:
      // a same-tab navigation away from /settings would have left this URL.
      expect(page.url()).toContain("/settings");

      // Video walkthrough for the evidence bundle (desktop walkthrough only;
      // mobile proves the same rendered CTA + popup, avoiding duplicate media).
      if (viewport.name === "desktop") {
        const video = page.video();
        // Close the context to flush the recording before transcoding — the
        // established pattern in launcher-cloud-gating.spec.ts.
        await page.context().close();
        if (video) {
          const artifact = await saveBrowserVideoArtifact({
            video,
            testInfo,
            basename: "walkthrough-connect-cloud-popup",
          });
          await testInfo.attach("walkthrough connect cloud popup", {
            path: artifact.path,
            contentType: artifact.contentType,
          });
        }
      }

      // Assert the visible connect state confirms the flow ran (login busy →
      // connecting state is the immediate rendered response; the exact label
      // depends on stub timing, so assert the popup contract instead, which is
      // the stable behavior under test).
      expect(popupName).toBe(CLOUD_LOGIN_POPUP_NAME);
    });
  }
});
