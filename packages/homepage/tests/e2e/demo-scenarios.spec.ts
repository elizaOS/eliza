/** Review-board coverage for the development-only full script view. */
import { expect, test } from "playwright/test";

test("shows all five rooms and their native attachment prototypes", async ({
  page,
}) => {
  await page.goto("/demo-scenarios", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Group chat demo scripts",
  );
  await expect(
    page.getByText(
      "Edit packages/homepage/src/lib/landing-demo.ts. This board and the homepage update together.",
    ),
  ).toBeVisible();
  const rooms = page.locator("[data-demo-review-room]");
  await expect(rooms).toHaveCount(5);

  await expect(
    page.locator('[data-demo-review-room="friends"] [data-demo-review-step]'),
  ).toHaveCount(21);
  await expect(
    page.locator('[data-demo-review-room="household"] [data-demo-review-step]'),
  ).toHaveCount(21);
  await expect(
    page.locator(
      '[data-demo-review-room]:not([data-demo-review-room="friends"]):not([data-demo-review-room="household"])',
    ),
  ).toHaveCount(3);
  for (const room of await page
    .locator(
      '[data-demo-review-room]:not([data-demo-review-room="friends"]):not([data-demo-review-room="household"])',
    )
    .all()) {
    await expect(room.locator("[data-demo-review-step]")).toHaveCount(20);
  }
  await expect(page.locator(".landing-demo-card")).toHaveCount(0);
  await expect(page.locator(".landing-place-attachment")).toHaveCount(1);
  await expect(page.locator(".landing-task-list-attachment")).toHaveCount(1);
  await expect(page.locator(".landing-place-fit")).toHaveCount(0);
  await expect(
    page.locator(".landing-task-list-attachment footer"),
  ).toHaveCount(0);
  await expect(
    page.locator(
      '[data-demo-review-room="friends"] [data-demo-review-step="place"] .demo-review-step-meta',
    ),
  ).toHaveCount(0);
  await expect(page.locator(".demo-review-plan-card")).toHaveCount(0);

  const castSources = await page
    .locator(".demo-review-cast img:not([src*='logo_white_orangebg'])")
    .evaluateAll((images) => images.map((image) => image.getAttribute("src")));
  expect(new Set(castSources).size).toBe(castSources.length);
  await expect(page.getByText("pasta?", { exact: true })).toBeVisible();
  await expect(page.getByText("3 people", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      /compare the calendars|mine is connected|check transit|ping me/i,
    ),
  ).toHaveCount(0);
});
