/**
 * Exercises exclusive App Permissions states and rejected grant recovery through
 * the production renderer and HTTP client, with deterministic server responses.
 */
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { saveBrowserVideoArtifact } from "./helpers/video-artifacts";

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`App Permissions recovers through exclusive states on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    const logs: string[] = [];
    page.on("console", (message) =>
      logs.push(`[console:${message.type()}] ${message.text()}`),
    );
    page.on("response", (response) =>
      logs.push(`[response] ${response.status()} ${response.url()}`),
    );
    page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));
    await page.setViewportSize(viewport);
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    let releaseFailure: () => void = () => {
      throw new Error("Request gate not initialized");
    };
    const firstRead = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let mode: "pending" | "empty" | "populated" = "pending";
    const app = {
      slug: "example-app",
      trust: "external",
      isolation: "worker",
      requestedPermissions: { fs: { read: ["documents/**"] } },
      recognisedNamespaces: ["fs"],
      grantedNamespaces: [],
      grantedAt: null,
    };
    await page.route("**/api/apps/permissions", async (route) => {
      if (mode === "pending") {
        await firstRead;
        await route.fulfill({
          status: 503,
          json: { error: "Permission inventory temporarily unavailable" },
        });
      } else {
        await route.fulfill({
          json:
            mode === "empty"
              ? [
                  {
                    ...app,
                    slug: "legacy-app",
                    requestedPermissions: null,
                    recognisedNamespaces: [],
                  },
                ]
              : [app],
        });
      }
    });
    let rejectGrant = true;
    await page.route("**/api/apps/permissions/example-app", async (route) => {
      expect(route.request().method()).toBe("PUT");
      expect(route.request().postDataJSON()).toEqual({ namespaces: ["fs"] });
      await route.fulfill(
        rejectGrant
          ? {
              status: 503,
              json: { error: "Grant update temporarily unavailable" },
            }
          : {
              json: {
                ...app,
                grantedNamespaces: ["fs"],
                grantedAt: new Date().toISOString(),
              },
            },
      );
    });
    await openAppPath(page, "/settings");
    await page.evaluate(() => {
      window.location.hash = "app-permissions";
    });
    const section = page.locator("#app-permissions");
    await expect(section.getByRole("status")).toContainText(
      "Loading app permissions",
    );
    await expect(
      section.getByText("No apps declare permissions yet."),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-permissions-loading.jpg`),
      fullPage: true,
    });
    releaseFailure();
    await expect(section.getByRole("alert")).toContainText(
      "Permission inventory temporarily unavailable",
    );
    await expect(
      section.getByText("No apps declare permissions yet."),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-permissions-error.jpg`),
      fullPage: true,
    });
    await section.getByRole("button", { name: "Refresh" }).hover();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-permissions-error-hover.jpg`),
      fullPage: true,
    });
    mode = "empty";
    await section.getByRole("button", { name: "Refresh" }).click();
    await expect(
      section.getByText("No apps declare permissions yet."),
    ).toBeVisible();
    await expect(section.getByRole("alert")).toHaveCount(0);
    await section
      .getByText("1 registered app without a permissions manifest")
      .click();
    await expect(
      section.getByText("legacy-app", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-permissions-empty.jpg`),
      fullPage: true,
    });
    mode = "populated";
    await section.getByRole("button", { name: "Refresh" }).click();
    const grant = section.getByRole("switch", { name: "Filesystem" });
    await expect(grant).toBeVisible();
    await expect(
      section.getByText("No apps declare permissions yet."),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-permissions-populated.jpg`),
      fullPage: true,
    });
    await grant.hover();
    await page.screenshot({
      path: testInfo.outputPath(
        `${viewport.name}-permissions-populated-hover.jpg`,
      ),
      fullPage: true,
    });
    await grant.click();
    await expect(
      section.getByText("Grant update temporarily unavailable", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(grant).not.toBeChecked();
    rejectGrant = false;
    await grant.click();
    await expect(grant).toBeChecked();
    await expect(
      section.getByText("Grant update temporarily unavailable", {
        exact: false,
      }),
    ).toHaveCount(0);
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
        basename: `${viewport.name}-permissions-retry`,
      });
      await testInfo.attach("permissions retry walkthrough", {
        path: artifact.path,
        contentType: artifact.contentType,
      });
    }
  });
}
