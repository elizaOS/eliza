/** Verifies Cockpit audit semantics against the real registered renderer and its usable empty form. */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { seedStewardSession } from "./helpers/test-auth";
import { normalize, positiveExpectationMatches } from "./ocr-content-rules";
import { resolveViewOcrPolicy } from "./ocr-view-expectations";

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`Cockpit audit recognizes the real empty form on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await seedAppStorage(page);
    await seedStewardSession(page, { jwt: true });
    await installDefaultAppRoutes(page);
    await openAppPath(page, "/cockpit");
    const cockpit = page.getByTestId("cockpit-view");
    await expect(
      cockpit.getByText("No active task rooms.", { exact: true }),
    ).toBeVisible();
    const goal = cockpit.getByTestId("cockpit-goal-input");
    await expect(goal).toBeVisible();
    const start = cockpit.getByRole("button", {
      name: "Start coding agent",
      exact: true,
    });
    await testInfo.attach("cockpit-layout", {
      body: JSON.stringify(
        await cockpit.evaluate((el) => {
          const rows = [];
          let item: Element | null = el;
          while (item) {
            const style = getComputedStyle(item);
            rows.push({
              tag: item.tagName,
              class: item.className,
              rect: item.getBoundingClientRect().toJSON(),
              height: style.height,
              padding: style.padding,
              overflow: style.overflow,
              flex: style.flex,
              clearance: style.getPropertyValue("--eliza-chat-clearance"),
            });
            item = item.parentElement;
          }
          return rows;
        }),
        null,
        2,
      ),
      contentType: "application/json",
    });
    await expect(start).toBeDisabled();
    await goal.fill("Inspect the repository without starting a paid agent");
    await expect(start).toBeEnabled();
    await start.click({ trial: true, timeout: 5_000 });
    await page
      .getByRole("button", {
        name: "Open Fast interactive terminal",
        exact: true,
      })
      .click({ trial: true, timeout: 5_000 });
    await expect(cockpit.getByTestId("cockpit-error")).toHaveCount(0);
    const policy = resolveViewOcrPolicy("plugin-cockpit-gui");
    if (policy.kind !== "expectation")
      throw new Error("Registered Cockpit must declare real content semantics");
    const matches = (text: string) =>
      positiveExpectationMatches(normalize(text), policy.expectation);
    expect(matches(await cockpit.innerText())).toBe(true);
    expect(matches("Coding Cockpit Loading…")).toBe(false);
    expect(
      matches("Coding Cockpit This view is unavailable Back to apps"),
    ).toBe(false);
    expect(
      matches((await cockpit.locator("button").allTextContents()).join(" ")),
    ).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath("cockpit-empty-form.png"),
      fullPage: true,
    });
  });
}
