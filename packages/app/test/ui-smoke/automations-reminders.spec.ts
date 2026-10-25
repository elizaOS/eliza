/** Real renderer reminder controls across desktop and phone layouts. */
import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { installDefaultAppRoutes, openAppPath } from "./helpers";

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`edits and snoozes a read reminder on ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await installDefaultAppRoutes(page);
    const dueAt = new Date(Date.now() + 60_000).toISOString();
    const row = {
      definition: {
        id: "reminder-visual",
        title: "Call the dentist about next week's appointment",
        description: "",
        status: "active",
        timezone: "UTC",
        cadence: { kind: "once", dueAt },
      },
      occurrence: {
        id: "occurrence-visual",
        dueAt,
        state: "visible",
        snoozedUntil: null as string | null,
        metadata: {},
      },
      latestAttempt: { outcome: "delivered_read" },
    };
    const mutations: Array<{ path: string; body: Record<string, unknown> }> =
      [];
    await page.route("**/api/lifeops/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/lifeops/reminders" && request.method() === "GET") {
        await route.fulfill({ json: { reminders: [row] } });
      } else if (
        path === "/api/lifeops/definitions/reminder-visual" &&
        request.method() === "PUT"
      ) {
        const body = request.postDataJSON();
        mutations.push({ path, body });
        row.definition.title = body.title;
        await route.fulfill({ json: { definition: row.definition } });
      } else if (
        path === "/api/lifeops/occurrences/occurrence-visual/snooze" &&
        request.method() === "POST"
      ) {
        const body = request.postDataJSON();
        mutations.push({ path, body });
        row.occurrence.snoozedUntil = new Date(
          Date.now() + 600_000,
        ).toISOString();
        row.occurrence.state = "snoozed";
        await route.fulfill({ json: row.occurrence });
      } else {
        await route.fallback();
      }
    });
    await openAppPath(page, "/automations");
    const reminder = page.getByRole("button", {
      name: row.definition.title,
      exact: true,
    });
    await expect(reminder).toBeVisible();
    await reminder.click();
    const message = page.getByText(row.definition.title, { exact: true });
    expect(
      await message.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", { name: "Snooze 10 minutes", exact: true }),
    ).toBeEnabled();
    const output = testOutputPath(
      "nubscarson-review",
      "reminder-ui",
      viewport.name,
    );
    await mkdir(output, { recursive: true });
    await page.screenshot({
      path: `${output}/read-reminder.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Edit message", exact: true })
      .click();
    await page
      .getByLabel("Reminder message", { exact: true })
      .fill("Call the clinic");
    await page.screenshot({
      path: `${output}/edit-reminder.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Call the clinic", exact: true }),
    ).toBeVisible();
    await expect.poll(() => mutations.length).toBe(1);
    expect(mutations[0]).toEqual({
      path: "/api/lifeops/definitions/reminder-visual",
      body: { title: "Call the clinic" },
    });
    await page
      .getByRole("button", { name: "Snooze 10 minutes", exact: true })
      .click();
    await expect.poll(() => mutations.length).toBe(2);
    expect(mutations[1]).toEqual({
      path: "/api/lifeops/occurrences/occurrence-visual/snooze",
      body: { minutes: 10 },
    });
    await expect(page.getByText("Snoozed", { exact: true })).toBeVisible();
    expect(row.occurrence.metadata).toEqual({});
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 2,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `${output}/snoozed-reminder.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "New automation", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Reminder", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Reminder", exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Reminder message", { exact: true })
      .fill("Bring the signed forms");
    await page.screenshot({
      path: `${output}/new-reminder.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 2,
      ),
    ).toBe(true);
  });
}
