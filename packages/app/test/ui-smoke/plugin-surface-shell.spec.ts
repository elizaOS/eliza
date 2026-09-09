/**
 * Exercises real Calendar and Messages renderers with deterministic HTTP
 * feeds. Short landscape screens keep the agenda readable and the message
 * composer reachable through ordinary scrolling.
 */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test("Calendar landscape scrolling exposes the event agenda", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/calendar");
  await expect(page.getByTestId("simple-calendar-view")).toBeVisible();
  await page
    .getByTestId("simple-calendar-view")
    .getByRole("button", { name: /1 event/ })
    .first()
    .click();
  const event = page
    .getByRole("article")
    .filter({ hasText: "Design sync" })
    .first();
  await expect(event).toBeAttached();
  await page.mouse.move(400, 260);
  await page.mouse.wheel(0, 500);
  await expect(event).toBeInViewport();
});

test("Messages landscape keeps status separate and composer reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/messages");
  const status = page.getByText("bridge-only", { exact: true });
  const role = page.getByRole("button", {
    name: "Set default SMS",
    exact: true,
  });
  await expect(status).toBeVisible();
  await expect(role).toBeVisible();
  const statusBox = await status.boundingBox();
  const roleBox = await role.boundingBox();
  if (!statusBox || !roleBox)
    throw new Error("Messages status controls are not laid out");
  expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(roleBox.y);
  await page.mouse.move(400, 260);
  await page.mouse.wheel(0, 500);
  const address = page.getByRole("textbox", { name: "To", exact: true });
  const body = page.getByRole("textbox", { name: "Body", exact: true });
  await expect(body).toBeInViewport();
  await address.fill("+15550101234");
  await body.fill("Layout regression draft");
  await expect(address).toHaveValue("+15550101234");
  await expect(body).toHaveValue("Layout regression draft");
  await expect(
    page.getByRole("button", { name: "Send SMS", exact: true }),
  ).toBeEnabled();
});
