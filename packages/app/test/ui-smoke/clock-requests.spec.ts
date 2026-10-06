/** Real renderer controls and composer handoff against quiet shell fixtures; no native alarm or model dispatch. */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`Clock request ${viewport.name} stays a draft and separates reminders`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
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
    await page.getByLabel("Alarm time", { exact: true }).fill("07:05");
    await page
      .getByLabel("Alarm label", { exact: true })
      .fill('Wake up "quietly"');
    await expect(prepare).toBeEnabled();
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
    await page.getByLabel("Alarm time", { exact: true }).fill("");
    await expect(prepare).toBeDisabled();
    await expect(page.getByRole("status")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Manage reminders", exact: true })
      .click();
    await expect(page).toHaveURL(/\/automations/);
  });
}
