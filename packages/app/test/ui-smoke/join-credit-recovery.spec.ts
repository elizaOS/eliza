/**
 * Exercises credit-gated onboarding through the real join controller and HTTP
 * client, with a locally fulfilled billing window and Dedicated identity.
 */
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { installDefaultAppRoutes } from "./helpers";
import { seedStewardSession } from "./helpers/test-auth";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`Credit recovery opens billing and reconnects on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    const logs: string[] = [];
    page.on("console", (message) =>
      logs.push(`[console:${message.type()}] ${message.text()}`),
    );
    page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));
    page.on("response", (response) =>
      logs.push(`[response] ${response.status()} ${response.url()}`),
    );
    await page.setViewportSize(viewport);
    await seedStewardSession(page, { jwt: true });
    await installDefaultAppRoutes(page);
    await page.route("**/api/auth/steward-session", (route) =>
      route.fulfill({ json: { success: true } }),
    );
    await page
      .context()
      .route("https://cloud.eliza.app/cloud/billing", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<h1>Fixture billing destination</h1>",
        }),
      );
    let funded = false;
    let identityReads = 0;
    const dedicatedId = "00000000-0000-4000-8000-000000000002";
    const personalId = "personal:00000000-0000-5000-8000-000000000001";
    await page.route("**/api/v1/eliza/personal", async (route) => {
      identityReads += 1;
      await route.fulfill(
        funded
          ? {
              json: {
                success: true,
                data: {
                  identity: {
                    id: personalId,
                    displayName: "Eliza",
                    runtime: "dedicated",
                    activeAgentId: dedicatedId,
                    apiBase: `https://${dedicatedId}.cloud.eliza.app`,
                  },
                },
              },
            }
          : {
              status: 402,
              json: {
                success: false,
                error: "At least $0.72 in hosting credit is required.",
              },
            },
      );
    });
    await page.goto("/join");
    const addCredits = page.getByRole("button", {
      name: "Add credits",
      exact: true,
    });
    await expect(addCredits).toBeVisible();
    await expect(
      page.getByText(/At least \$0\.72 in hosting credit is required\./),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-credit-gate-rest.jpg`),
      fullPage: true,
    });
    await addCredits.hover();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-credit-gate-hover.jpg`),
      fullPage: true,
    });
    const popupPromise = page.context().waitForEvent("page");
    await addCredits.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL("https://cloud.eliza.app/cloud/billing");
    await expect(
      popup.getByRole("heading", { name: "Fixture billing destination" }),
    ).toBeVisible();
    await popup.close();
    funded = true;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const stored = localStorage.getItem("elizaos:active-server");
          return stored ? JSON.parse(stored).cloudRuntimeAgentId : null;
        }),
      )
      .toBe(dedicatedId);
    expect(identityReads).toBeGreaterThanOrEqual(2);
    await expect(addCredits).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-credit-reconnected.jpg`),
      fullPage: true,
    });
    const logPath = testInfo.outputPath(`${viewport.name}-console-network.log`);
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
        basename: `${viewport.name}-credit-recovery`,
      });
      await testInfo.attach("credit recovery walkthrough", {
        path: artifact.path,
        contentType: artifact.contentType,
      });
    }
  });
}
