/**
 * Exercises Account and Billing sign-in through the production renderer and auth store,
 * with only upstream HTTP responses supplied by deterministic fixtures.
 * A connected agent must not satisfy a signed-out browser's account session.
 */
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  hideChatOverlay,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

for (const section of ["account", "billing"]) {
  for (const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    test(`${section} starts browser sign-in with a connected agent on ${viewport.name}`, async ({
      page,
      baseURL,
    }, testInfo) => {
      const logs: string[] = [];
      page.on("console", (message) =>
        logs.push(`[console:${message.type()}] ${message.text()}`),
      );
      page.on("pageerror", (error) =>
        logs.push(`[pageerror] ${error.message}`),
      );
      page.on("request", (request) =>
        logs.push(`[request] ${request.method()} ${request.url()}`),
      );
      page.on("response", (response) =>
        logs.push(`[response] ${response.status()} ${response.url()}`),
      );
      await page.setViewportSize(viewport);
      await seedAppStorage(page, {
        "elizaos:active-server": JSON.stringify({
          id: "cloud:22222222-2222-4222-8222-222222222222",
          kind: "cloud",
          label: "Eliza Cloud",
          apiBase: `${baseURL}/api/v1/eliza/agents/22222222-2222-4222-8222-222222222222`,
          cloudRuntimeAgentId: "22222222-2222-4222-8222-222222222222",
          cloudRuntime: "dedicated",
        }),
      });
      await installDefaultAppRoutes(page);
      await page.route("**/api/cloud/status", async (route) => {
        await route.fulfill({
          json: {
            connected: true,
            enabled: true,
            hasApiKey: true,
            cloudVoiceProxyAvailable: false,
          },
        });
      });
      let rejectLogin = true;
      await page.route("**/api/cloud/login", async (route) => {
        if (rejectLogin) {
          await route.fulfill({
            status: 503,
            json: {
              ok: false,
              error: "Sign-in service temporarily unavailable",
            },
          });
          return;
        }
        await route.fulfill({
          json: {
            ok: true,
            sessionId: "account-sign-in-session",
            browserUrl:
              "https://www.elizacloud.ai/device/account-sign-in-session",
          },
        });
      });
      await page
        .context()
        .route(
          "https://www.elizacloud.ai/device/account-sign-in-session",
          async (route) => {
            await route.fulfill({
              contentType: "text/html",
              body: "<h1>Authorize your browser</h1>",
            });
          },
        );
      await hideChatOverlay(page);
      await openAppPath(page, "/settings");
      await page.evaluate((section) => {
        window.location.hash = `cloud-${section}`;
      }, section);
      const signIn = page.getByRole("button", { name: /^sign in$/i });
      await expect(signIn).toBeVisible({ timeout: 60_000 });
      await page.screenshot({
        path: testInfo.outputPath(`${viewport.name}-${section}-rest.jpg`),
        fullPage: true,
      });
      await signIn.hover();
      await page.screenshot({
        path: testInfo.outputPath(`${viewport.name}-${section}-hover.jpg`),
        fullPage: true,
      });
      const loginRequest = page.waitForRequest(
        (request) =>
          request.url().endsWith("/api/cloud/login") &&
          request.method() === "POST",
        { timeout: 15_000 },
      );
      await signIn.click();
      await loginRequest;
      await expect(page.getByRole("alert")).toContainText(
        "Sign-in service temporarily unavailable",
      );
      await expect(signIn).toBeEnabled();
      await page.screenshot({
        path: testInfo.outputPath(
          `${viewport.name}-${section}-signin-error.jpg`,
        ),
        fullPage: true,
      });
      rejectLogin = false;
      const popupPromise = page.waitForEvent("popup");
      await signIn.click();
      const popup = await popupPromise;
      await expect(popup).toHaveURL(
        "https://www.elizacloud.ai/device/account-sign-in-session",
      );
      await expect(
        popup.getByRole("heading", { name: "Authorize your browser" }),
      ).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/settings#cloud-${section}$`));
      const logPath = testInfo.outputPath(
        `${viewport.name}-console-network.log`,
      );
      await writeFile(logPath, logs.join("\n"));
      await testInfo.attach("console and network", {
        path: logPath,
        contentType: "text/plain",
      });
      const video = page.video();
      await page.context().close();
      if (video) {
        const artifact = await saveBrowserVideoArtifact({
          video,
          testInfo,
          basename: `${viewport.name}-${section}-signin-retry`,
        });
        await testInfo.attach("sign-in retry walkthrough", {
          path: artifact.path,
          contentType: artifact.contentType,
        });
      }
    });
  }
}
