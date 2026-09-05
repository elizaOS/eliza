/**
 * Exercises the Focus request and retry through the production renderer and
 * HTTP client, with deterministic upstream responses and recorded UI evidence.
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
  test(`Focus request exposes failure and permits retry on ${viewport.name}`, async ({
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
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await page.route("**/api/conversations", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({
        json: {
          conversation: {
            id: "focus-request",
            title: "Focus",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
      });
    });
    let shouldFail = true;
    let requests = 0;
    await page.route(
      "**/api/conversations/focus-request/messages",
      async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        requests += 1;
        expect(route.request().postDataJSON()).toMatchObject({
          text: "Start a focus session for me.",
        });
        await route.fulfill(
          shouldFail
            ? {
                status: 503,
                json: { error: "Focus assistant temporarily unavailable" },
              }
            : {
                json: {
                  text: "Which websites should I block?",
                  agentName: "Eliza",
                },
              },
        );
      },
    );
    for (const view of ["finances", "goals", "health", "inbox", "todos"]) {
      await openAppPath(page, `/${view}`);
      const control =
        view === "inbox"
          ? page.getByRole("button", { name: "Email", exact: true })
          : view === "todos"
            ? page.getByRole("button", { name: "Add todo", exact: true })
            : page.getByRole("combobox").first();
      await expect(control).toBeVisible({ timeout: 60_000 });
      await page.screenshot({
        path: testInfo.outputPath(`${viewport.name}-${view}-rest.jpg`),
        fullPage: true,
      });
      await control.hover();
      await page.screenshot({
        path: testInfo.outputPath(`${viewport.name}-${view}-hover.jpg`),
        fullPage: true,
      });
    }
    await openAppPath(page, "/focus");
    const start = page.getByRole("button", {
      name: "Start focus",
      exact: true,
    });
    await expect(start).toBeVisible({ timeout: 60_000 });
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-focus-rest.jpg`),
      fullPage: true,
    });
    await start.hover();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-focus-hover.jpg`),
      fullPage: true,
    });
    await start.click();
    await expect(
      page.getByText("Focus assistant temporarily unavailable", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(start).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-focus-error.jpg`),
      fullPage: true,
    });
    shouldFail = false;
    await start.click();
    await expect(
      page.getByText("Which websites should I block?", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No focus session active", { exact: true }),
    ).toBeVisible();
    expect(requests).toBe(2);
    await page.screenshot({
      path: testInfo.outputPath(`${viewport.name}-focus-reply.jpg`),
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
        basename: `${viewport.name}-focus-retry`,
      });
      await testInfo.attach("focus retry walkthrough", {
        path: artifact.path,
        contentType: artifact.contentType,
      });
    }
  });
}
