/** Real-browser Cloud account gating and sign-in discovery recovery with a connected agent. */
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { installDefaultAppRoutes, seedAppStorage } from "./helpers";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

for (const section of ["account", "billing"]) {
  for (const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    test(`${section} requires browser sign-in despite a connected agent on ${viewport.name}`, async ({
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
      let rejectDiscovery = true;
      let providerRequests = 0;
      await page.route("**/auth/providers", async (route) => {
        providerRequests += 1;
        if (rejectDiscovery) {
          await route.fulfill({
            status: 503,
            json: { error: "Sign-in service temporarily unavailable" },
          });
          return;
        }
        await route.fulfill({
          json: {
            passkey: false,
            email: true,
            sms: false,
            siwe: false,
            siws: false,
            google: true,
            discord: false,
            github: false,
            twitter: false,
            oauth: [],
          },
        });
      });
      // Web settings anchors redirect to the canonical management route, whose
      // browser session gate must not accept an agent's Cloud connection.
      await page.goto(`${baseURL}/settings#cloud-${section}`);
      await expect(
        page.getByRole("heading", { name: "Sign in", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("alert")).toContainText(
        "Sign-in options couldn't load",
      );
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === "/login" &&
          url.searchParams.get("returnTo") === `/cloud/${section}`,
      );
      await page.screenshot({
        path: testInfo.outputPath(
          `${viewport.name}-${section}-signin-error.jpg`,
        ),
        fullPage: true,
      });
      const retry = page.getByRole("button", { name: "Retry sign-in options" });
      await expect(retry).toBeEnabled();
      await retry.hover();
      await page.screenshot({
        path: testInfo.outputPath(
          `${viewport.name}-${section}-retry-hover.jpg`,
        ),
        fullPage: true,
      });
      const requestsBeforeRetry = providerRequests;
      rejectDiscovery = false;
      await retry.click();
      await expect(
        page.getByRole("button", { name: "Google", exact: true }),
      ).toBeVisible();
      await expect
        .poll(() => providerRequests)
        .toBeGreaterThan(requestsBeforeRetry);
      await expect(
        page.getByText("Sign-in options couldn't load", { exact: true }),
      ).toHaveCount(0);
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === "/login" &&
          url.searchParams.get("returnTo") === `/cloud/${section}`,
      );
      await page.screenshot({
        path: testInfo.outputPath(
          `${viewport.name}-${section}-signin-ready.jpg`,
        ),
        fullPage: true,
      });
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
