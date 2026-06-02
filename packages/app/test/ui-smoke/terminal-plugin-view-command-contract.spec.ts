import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type TuiCommandEvent = {
  viewId: string;
  command: string;
};

test.describe("shared terminal plugin view command contract", () => {
  test("posts the selected capability and renders semantic output", async ({
    page,
  }) => {
    const interactRequests: unknown[] = [];

    await page.addInitScript(() => {
      const target = window as Window & {
        __feedTuiCommandEvents?: TuiCommandEvent[];
      };
      target.__feedTuiCommandEvents = [];
      window.addEventListener("eliza:tui-command", (event) => {
        target.__feedTuiCommandEvents?.push(
          (event as CustomEvent<TuiCommandEvent>).detail,
        );
      });
    });

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

    await openAppPath(page, "/feed/tui");

    const tuiRoot = page.locator("[data-view-state]").first();
    await expect(tuiRoot).toBeVisible();
    await expect
      .poll(async () =>
        JSON.parse((await tuiRoot.getAttribute("data-view-state")) ?? "{}"),
      )
      .toMatchObject({
        viewType: "tui",
        viewId: "feed",
        commandCount: 4,
      });

    await page
      .locator('[data-terminal-command="refresh-agent-status"]')
      .click();

    await expect
      .poll(() => interactRequests)
      .toEqual([
        {
          capability: "refresh-agent-status",
          timeoutMs: 5000,
        },
      ]);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as Window & {
                __feedTuiCommandEvents?: TuiCommandEvent[];
              }
            ).__feedTuiCommandEvents ?? [],
        ),
      )
      .toEqual([{ viewId: "feed", command: "refresh-agent-status" }]);

    const output = page.locator('[data-terminal-output="ok"]').last();
    await expect(output).toContainText("$ refresh-agent-status");
    await expect(output).toContainText(
      /"capability":\s*"refresh-agent-status"/,
    );
    await expect(output).toContainText(/"source":\s*"ui-smoke"/);
  });
});
