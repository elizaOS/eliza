/**
 * View-switching UI coverage.
 *
 * The dashboard "My Agents" surface (`/dashboard/my-agents`) exposes a
 * segmented grid/list view toggle in CharacterFilters
 * (src/components/my-agents/character-filters.tsx). The toggle contains two
 * icon-only buttons (LayoutGrid / List from lucide). Per the component
 * source the active button receives `bg-white text-[#0c4f8d] shadow-sm`,
 * and the underlying CharacterLibraryGrid switches between
 * `grid sm:grid-cols-2 ...` and `grid grid-cols-1` based on the mode.
 *
 * The component uses local `useState` — view mode does NOT persist across
 * a full page reload by design. The persistence assertion below documents
 * that and intentionally asserts the reset behavior; if persistence is
 * added later (localStorage / URL param), the test will flag it.
 *
 * Auth on /dashboard is satisfied by the same `eliza-test-auth=1` cookie
 * + `VITE_PLAYWRIGHT_TEST_AUTH=true` bypass the aesthetic-audit spec uses.
 */

import { expect, type BrowserContext, type Page, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "View-switching test relies on local-only auth bypass.",
);

const MY_AGENTS_ROUTE = "/dashboard/my-agents";

async function setTestAuthCookie(context: BrowserContext) {
  await context.addCookies([
    {
      name: "eliza-test-auth",
      value: "1",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

/**
 * The view-toggle container has class `flex h-9 shrink-0 rounded-full border ...`
 * and contains exactly two `<button type="button">` children. The first holds
 * a LayoutGrid icon, the second a List icon. We locate by structure so the
 * spec doesn't depend on Tailwind class names that may shift.
 */
function viewToggleButtons(page: Page) {
  // Anchor on the lucide icons — each is rendered as an <svg> with the
  // `lucide-layout-grid` / `lucide-list` class lucide-react adds.
  const gridButton = page
    .locator("button:has(svg.lucide-layout-grid)")
    .first();
  const listButton = page.locator("button:has(svg.lucide-list)").first();
  return { gridButton, listButton };
}

test.describe("view-switching: my-agents grid/list toggle", () => {
  test.beforeEach(async ({ context, page }) => {
    await setTestAuthCookie(context);
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
    (page as unknown as { __consoleErrors: string[] }).__consoleErrors =
      consoleErrors;
  });

  test("both toggle buttons render", async ({ page }) => {
    await page.goto(MY_AGENTS_ROUTE, { waitUntil: "domcontentloaded" });
    const { gridButton, listButton } = viewToggleButtons(page);
    await expect(gridButton).toBeVisible({ timeout: 15_000 });
    await expect(listButton).toBeVisible({ timeout: 15_000 });
    await expect(gridButton).toBeEnabled();
    await expect(listButton).toBeEnabled();
  });

  test("clicking list then grid updates the active state, no console errors", async ({
    page,
  }) => {
    await page.goto(MY_AGENTS_ROUTE, { waitUntil: "domcontentloaded" });
    const { gridButton, listButton } = viewToggleButtons(page);
    await expect(gridButton).toBeVisible({ timeout: 15_000 });

    // Default state is grid — the active button gets a white background.
    const gridBgInitial = await gridButton.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    const listBgInitial = await listButton.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(gridBgInitial).not.toBe(listBgInitial);

    // Switch to list — its background should now be the "active" color.
    await listButton.click();
    await expect.poll(async () =>
      listButton.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(gridBgInitial);

    // Switch back to grid.
    await gridButton.click();
    await expect.poll(async () =>
      gridButton.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(gridBgInitial);

    const errors = (page as unknown as { __consoleErrors: string[] }).__consoleErrors.filter(
      (m) => !m.includes("404") && !m.includes("net::"),
    );
    expect(errors, `unexpected console errors: ${errors.join("\n")}`).toHaveLength(0);
  });

  test("toggling switches the underlying grid layout class", async ({ page }) => {
    await page.goto(MY_AGENTS_ROUTE, { waitUntil: "domcontentloaded" });
    const { gridButton, listButton } = viewToggleButtons(page);
    await expect(gridButton).toBeVisible({ timeout: 15_000 });

    // CharacterLibraryGrid renders the agent container with either
    // `sm:grid-cols-2 lg:grid-cols-3 ...` (grid) or `grid-cols-1` (list).
    // If the library is empty (mock backend), an EmptyState renders instead
    // and the container class isn't present — in that case we skip the
    // layout-class assertion but still verify the toggle responds.
    const gridContainer = page.locator("div.grid").filter({
      hasNot: page.locator("svg.lucide-layout-grid"),
    });
    const containerCount = await gridContainer.count();
    test.skip(
      containerCount === 0,
      "no agent library container rendered (likely empty state); toggle visibility covered elsewhere",
    );

    await listButton.click();
    await expect.poll(async () =>
      gridContainer.first().getAttribute("class"),
    ).toMatch(/grid-cols-1/);

    await gridButton.click();
    await expect.poll(async () =>
      gridContainer.first().getAttribute("class"),
    ).toMatch(/sm:grid-cols-2|md:grid-cols|lg:grid-cols/);
  });

  test("view mode does NOT persist across reload (uses local useState)", async ({
    page,
  }) => {
    await page.goto(MY_AGENTS_ROUTE, { waitUntil: "domcontentloaded" });
    const { gridButton, listButton } = viewToggleButtons(page);
    await expect(gridButton).toBeVisible({ timeout: 15_000 });

    const initialGridBg = await gridButton.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    await listButton.click();
    await page.waitForTimeout(200);

    await page.reload({ waitUntil: "domcontentloaded" });
    const { gridButton: gridAfter } = viewToggleButtons(page);
    await expect(gridAfter).toBeVisible({ timeout: 15_000 });

    // After reload the default ("grid") should be active again — i.e. the
    // grid button's background matches the original active background.
    await expect.poll(async () =>
      gridAfter.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(initialGridBg);
  });
});
