/** Review-board coverage for the development-only full script view. */
import { expect, test } from "playwright/test";

test("shows all five rooms, 24 beats each, with distinct casts", async ({
  page,
}) => {
  await page.goto("/demo-scenarios", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Group chat demo scripts",
  );
  const rooms = page.locator("[data-demo-review-room]");
  await expect(rooms).toHaveCount(5);

  for (const room of await rooms.all()) {
    await expect(room.locator("[data-demo-review-step]")).toHaveCount(24);
  }

  const castSources = await page
    .locator(".demo-review-cast img:not([src*='logo_white_orangebg'])")
    .evaluateAll((images) => images.map((image) => image.getAttribute("src")));
  expect(new Set(castSources).size).toBe(castSources.length);
  await expect(page.getByText("pasta?", { exact: true })).toBeVisible();
  await expect(page.getByText("2 parents + Eliza")).toBeVisible();
  await expect(
    page.getByText(
      /compare the calendars|mine is connected|check transit|ping me/i,
    ),
  ).toHaveCount(0);
});
