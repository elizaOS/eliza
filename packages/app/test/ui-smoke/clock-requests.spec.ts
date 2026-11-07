/** Real launcher-to-Clock navigation without a native host; no alarm or model dispatch. */
import { mkdir } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

async function captureRenderedState(
  page: Page,
  viewport: string,
  state: string,
) {
  const directory = testOutputPath("clock-completion", "renderer-flow");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: `${directory}/${viewport}-${state}.png`,
    fullPage: true,
  });
  // Recorded review needs a painted frame between fast DOM-only test steps.
  if (process.env.E2E_RECORD) await page.waitForTimeout(500);
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`Clock request ${viewport.name} shows native availability without creating an alarm`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport: { width: viewport.width, height: viewport.height },
      serviceWorkers: "block",
      ...(process.env.E2E_RECORD
        ? {
            recordVideo: {
              dir: testOutputPath(
                "clock-completion",
                "renderer-video",
                viewport.name,
              ),
              size: { width: viewport.width, height: viewport.height },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    try {
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);
      const effects: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() !== "GET" &&
          /\/api\/(?:client-devices|lifeops\/reminders|chat|conversations.*messages)/.test(
            request.url(),
          )
        )
          effects.push(request.url());
      });
      await openAppPath(page, "/views");
      await expect(page.getByTestId("launcher-tile-clock")).toBeVisible();
      const draft = "Keep this unsent message while I check Clock.";
      await page
        .getByRole("textbox", { name: "message", exact: true })
        .fill(draft);
      await captureRenderedState(page, viewport.name, "launcher");
      await page
        .getByTestId("launcher-tile-clock")
        .getByRole("button", { name: "Clock", exact: true })
        .click();
      await expect(page).toHaveURL(/\/clock/);
      await expect(
        page.getByRole("heading", { name: "Alarms", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Open Clock on your Android phone to manage alarms.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Add alarm", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "Clock proposals", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "message", exact: true }),
      ).toHaveValue(draft);
      expect(effects).toEqual([]);
      await captureRenderedState(page, viewport.name, "native-unavailable");
    } finally {
      await context.close();
    }
  });
}
