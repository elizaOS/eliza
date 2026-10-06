/** Real renderer controls and composer handoff against quiet shell fixtures; no native alarm or model dispatch. */
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
  const directory = testOutputPath("clock-preparation", "flow");
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
  test(`Clock request ${viewport.name} stays a draft and separates reminders`, async ({
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
                "clock-preparation",
                "raw-video",
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
      await captureRenderedState(page, viewport.name, "launcher");
      await page
        .getByTestId("launcher-tile-clock")
        .getByRole("button", { name: "Clock", exact: true })
        .click();
      await expect(page).toHaveURL(/\/clock/);
      await expect(
        page.getByRole("heading", { name: "Android alarm", exact: true }),
      ).toBeVisible();
      const prepare = page.getByRole("button", {
        name: "Prepare alarm request",
        exact: true,
      });
      await expect(prepare).toBeDisabled();
      await captureRenderedState(page, viewport.name, "clock");
      await page.getByLabel("Alarm time", { exact: true }).fill("07:05");
      await page
        .getByLabel("Alarm label", { exact: true })
        .fill('Wake up "quietly"');
      await expect(prepare).toBeEnabled();
      await captureRenderedState(page, viewport.name, "filled");
      await prepare.click();
      await expect(page.getByRole("status")).toHaveText(
        "Request ready in chat. No alarm has been installed.",
      );
      await expect(
        page.getByRole("textbox", { name: "message", exact: true }),
      ).toHaveValue(
        'Propose an Android Clock alarm for 07:05 in my phone\'s current timezone with label "Wake up \\"quietly\\"". Ask me to review it before dispatch.',
      );
      expect(effects).toEqual([]);
      await captureRenderedState(page, viewport.name, "prepared");
      await page.getByLabel("Alarm time", { exact: true }).fill("");
      await expect(prepare).toBeDisabled();
      await expect(page.getByRole("status")).toHaveCount(0);
      await captureRenderedState(page, viewport.name, "invalid");
      await page
        .getByRole("button", { name: "Manage reminders", exact: true })
        .click();
      await expect(page).toHaveURL(/\/automations/);
      await expect(page.getByTestId("automations-layout")).toBeVisible();
      await captureRenderedState(page, viewport.name, "reminders");
    } finally {
      await context.close();
    }
  });
}
