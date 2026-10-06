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
  test(`Clock request ${viewport.name} preserves repeat drafts and separates reminders`, async ({
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
        `Propose an Android Clock alarm for 07:05 once in my phone's current timezone with label ${JSON.stringify('Wake up "quietly"')}. Preserve the repeat days and ask me to review before dispatch.`,
      );
      expect(effects).toEqual([]);
      await captureRenderedState(page, viewport.name, "prepared");

      const time = page.getByLabel("Alarm time", { exact: true });
      const repeat = page.getByRole("combobox", {
        name: "Repeat",
        exact: true,
      });
      const composer = page.getByRole("textbox", {
        name: "message",
        exact: true,
      });
      await time.fill("09:00");
      await page.getByLabel("Alarm label", { exact: true }).fill("");
      for (const scenario of [
        { option: "Every day", text: "every day", state: "every-day" },
        {
          option: "Weekdays (Monday–Friday)",
          text: "every weekday (Monday through Friday)",
          state: "weekdays",
        },
      ]) {
        await repeat.selectOption({ label: scenario.option });
        await expect(prepare).toBeEnabled();
        await prepare.click();
        await expect(composer).toHaveValue(
          `Propose an Android Clock alarm for 09:00 ${scenario.text} in my phone's current timezone. Preserve the repeat days and ask me to review before dispatch.`,
        );
        await expect(page.getByRole("status")).toHaveText(
          "Request ready in chat. No alarm has been installed.",
        );
        expect(effects).toEqual([]);
        await captureRenderedState(page, viewport.name, scenario.state);
      }

      await repeat.selectOption({ label: "Selected days" });
      await expect(prepare).toBeDisabled();
      await expect(page.getByRole("status")).toHaveCount(0);
      const repeatDays = page.getByRole("group", {
        name: "Repeat days",
        exact: true,
      });
      await expect(repeatDays).toBeVisible();
      await expect(
        repeatDays.getByRole("checkbox", { checked: true }),
      ).toHaveCount(0);
      await captureRenderedState(page, viewport.name, "no-repeat-days");
      // Deliberately select out of calendar order; the draft must retain exactly
      // these days in canonical order, without widening them to weekdays/daily.
      for (const day of ["Friday", "Sunday", "Monday"]) {
        await repeatDays
          .getByRole("checkbox", { name: day, exact: true })
          .check();
      }
      await expect(
        repeatDays.getByRole("checkbox", { checked: true }),
      ).toHaveCount(3);
      await expect(prepare).toBeEnabled();
      await prepare.click();
      const customDraft =
        "Propose an Android Clock alarm for 09:00 every Sunday, Monday, Friday in my phone's current timezone. Preserve the repeat days and ask me to review before dispatch.";
      await expect(composer).toHaveValue(customDraft);
      expect(effects).toEqual([]);
      await captureRenderedState(page, viewport.name, "selected-days");
      for (const day of ["Friday", "Sunday", "Monday"]) {
        await repeatDays
          .getByRole("checkbox", { name: day, exact: true })
          .uncheck();
      }
      await expect(prepare).toBeDisabled();
      await expect(page.getByRole("status")).toHaveCount(0);
      await expect(composer).toHaveValue(customDraft);

      // A valid repeat cannot make an invalid clock time dispatchable.
      await repeat.selectOption({ label: "Every day" });
      await expect(prepare).toBeEnabled();
      for (const invalidTime of ["24:00", "09:60", "9:00"]) {
        await time.fill(invalidTime);
        await expect(prepare).toBeDisabled();
        await expect(page.getByRole("status")).toHaveCount(0);
        await expect(composer).toHaveValue(customDraft);
      }
      expect(effects).toEqual([]);
      await captureRenderedState(page, viewport.name, "bad-time");
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
      expect(effects).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
