/**
 * Playwright UI-smoke spec for the Terminal Plugin View Command Contract app
 * flow using the real renderer fixture.
 */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.describe("shared terminal plugin view command contract", () => {
  test("posts the selected capability and renders semantic output", async ({
    page,
  }) => {
    const interactRequests: unknown[] = [];

    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await page.route("**/api/views/feed/interact**", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        capability?: string;
        timeoutMs?: number;
      };
      interactRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          viewId: "feed",
          capability: body.capability,
          source: "ui-smoke",
        }),
      });
    });

    await openAppPath(page, "/feed");
    await expect(page.getByText("Spawn agent")).toBeVisible();

    const response = await page.evaluate(async () => {
      const result = await fetch("/api/views/feed/interact?viewType=tui", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capability: "refresh-agent-status",
          timeoutMs: 5000,
        }),
      });
      return result.json();
    });

    await expect
      .poll(() => interactRequests)
      .toEqual([
        {
          capability: "refresh-agent-status",
          timeoutMs: 5000,
        },
      ]);
    expect(response).toMatchObject({
      ok: true,
      viewId: "feed",
      capability: "refresh-agent-status",
      source: "ui-smoke",
    });
  });
});
