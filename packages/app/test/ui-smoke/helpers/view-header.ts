/** Browser contract for views whose shared header now renders actions only. */
import { expect, type Page } from "@playwright/test";

/**
 * Call after route-specific readiness checks so an empty page cannot pass.
 * Shared ViewHeader no longer duplicates a title or launcher-back row; real
 * page controls and section navigation remain part of each caller's checks.
 */
export async function assertHeaderlessViewChrome(
  page: Page,
  { within }: { within?: string } = {},
): Promise<void> {
  const scope = within ? page.locator(within) : page.locator("#root");
  await expect(scope).toBeVisible();
  await expect(scope.getByTestId("view-header")).toHaveCount(0);
  await expect(
    scope.getByRole("button", { name: "Back to launcher", exact: true }),
  ).toHaveCount(0);
}
