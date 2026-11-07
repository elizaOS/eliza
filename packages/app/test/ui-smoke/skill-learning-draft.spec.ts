/** Proves the skill CTA reaches the real shared composer without a silent send. */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`Learn a skill opens an editable draft at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await page.route("**/api/skills/curated", (route) =>
      route.fulfill({ json: { skills: [] } }),
    );
    const messagePosts: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/messages(?:\/stream)?(?:\?|$)/.test(request.url())
      )
        messagePosts.push(request.url());
    });
    await openAppPath(page, "/character/skills");
    await page
      .getByRole("button", { name: "Learn a skill", exact: true })
      .click();
    const composer = page.getByTestId("chat-composer-textarea");
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue(
      "Help me learn a new skill. Ask what capability I want to practice.",
    );
    await expect(composer).toBeFocused();
    await composer.fill("I want to practice organizing appointments.");
    await expect(composer).toHaveValue(
      "I want to practice organizing appointments.",
    );
    expect(messagePosts).toEqual([]);
  });
}
