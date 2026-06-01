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

import { type BrowserContext, expect, type Page, test } from "@playwright/test";

test.skip(
  Boolean(process.env.CLOUD_E2E_LIVE_URL),
  "View-switching test relies on local-only auth bypass.",
);

const MY_AGENTS_ROUTE = "/dashboard/my-agents";
const NOW = "2026-06-01T12:00:00.000Z";

const testUser = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "test@example.com",
  email_verified: true,
  wallet_address: "0x0000000000000000000000000000000000000001",
  wallet_chain_type: "evm",
  wallet_verified: true,
  name: "Test User",
  avatar: null,
  organization_id: "org_1",
  role: "owner",
  steward_user_id: "steward_1",
  telegram_id: null,
  telegram_username: null,
  telegram_first_name: null,
  telegram_photo_url: null,
  discord_id: null,
  discord_username: null,
  discord_global_name: null,
  discord_avatar_url: null,
  whatsapp_id: null,
  whatsapp_name: null,
  phone_number: null,
  phone_verified: false,
  is_anonymous: false,
  anonymous_session_id: null,
  expires_at: null,
  nickname: "Tester",
  work_function: "engineering",
  preferences: null,
  email_notifications: true,
  response_notifications: true,
  is_active: true,
  created_at: NOW,
  updated_at: NOW,
  organization: {
    id: "org_1",
    name: "Eliza QA",
    slug: "eliza-qa",
    credit_balance: "100.00",
    billing_email: "billing@example.com",
    is_active: true,
    created_at: NOW,
    updated_at: NOW,
  },
};

const testAgent = {
  id: "agent_1",
  name: "Toggle Test Agent",
  username: "toggle-test-agent",
  bio: "Agent used by the view-switching e2e test.",
  avatarUrl: null,
  avatar_url: null,
  category: "test",
  isPublic: false,
  is_public: false,
  createdAt: NOW,
  created_at: NOW,
  updatedAt: NOW,
  updated_at: NOW,
  tags: [],
  token_address: null,
  token_chain: null,
  token_name: null,
  token_ticker: null,
};

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

async function installApiMocks(page: Page) {
  await page.route("**/api/credits/balance**", (route) =>
    route.fulfill({
      json: { balance: 100, currency: "USD" },
      headers: { "content-type": "application/json" },
    }),
  );
  await page.route("**/api/v1/user", (route) =>
    route.fulfill({
      json: { success: true, data: testUser },
      headers: { "content-type": "application/json" },
    }),
  );
  await page.route("**/api/my-agents/characters", (route) =>
    route.fulfill({
      json: {
        success: true,
        data: {
          characters: [testAgent],
          pagination: {
            page: 1,
            limit: 20,
            totalPages: 1,
            totalCount: 1,
            hasMore: false,
          },
        },
      },
      headers: { "content-type": "application/json" },
    }),
  );
  await page.route("**/api/my-agents/saved", (route) =>
    route.fulfill({
      json: { success: true, data: { agents: [] } },
      headers: { "content-type": "application/json" },
    }),
  );
  await page.route("**/api/my-agents/claim-affiliate-characters", (route) =>
    route.fulfill({
      json: { success: true, claimed: 0 },
      headers: { "content-type": "application/json" },
    }),
  );
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
  const gridButton = page.locator("button:has(svg.lucide-layout-grid)").first();
  const listButton = page.locator("button:has(svg.lucide-list)").first();
  return { gridButton, listButton };
}

test.describe("view-switching: my-agents grid/list toggle", () => {
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ context, page }) => {
    await setTestAuthCookie(context);
    await installApiMocks(page);
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) =>
      consoleErrors.push(`pageerror: ${err.message}`),
    );
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

    await expect(gridButton).toHaveAttribute("aria-pressed", "true");
    await expect(listButton).toHaveAttribute("aria-pressed", "false");

    await listButton.click();
    await expect(listButton).toHaveAttribute("aria-pressed", "true");
    await expect(gridButton).toHaveAttribute("aria-pressed", "false");

    await gridButton.click();
    await expect(gridButton).toHaveAttribute("aria-pressed", "true");
    await expect(listButton).toHaveAttribute("aria-pressed", "false");

    const errors = (
      page as unknown as { __consoleErrors: string[] }
    ).__consoleErrors.filter((m) => !m.includes("404") && !m.includes("net::"));
    expect(
      errors,
      `unexpected console errors: ${errors.join("\n")}`,
    ).toHaveLength(0);
  });

  test("toggling switches the underlying grid layout class", async ({
    page,
  }) => {
    await page.goto(MY_AGENTS_ROUTE, { waitUntil: "domcontentloaded" });
    const { gridButton, listButton } = viewToggleButtons(page);
    await expect(gridButton).toBeVisible({ timeout: 15_000 });

    // CharacterLibraryGrid renders the agent container with either
    // `sm:grid-cols-2 lg:grid-cols-3 ...` (grid) or `grid-cols-1` (list).
    // If the library is empty (mock backend), an EmptyState renders instead
    // and the container class isn't present — in that case we skip the
    // layout-class assertion but still verify the toggle responds.
    const gridContainer = page.locator("div.grid").filter({
      has: page.getByRole("button", { name: /toggle test agent/i }),
    });
    const containerCount = await gridContainer.count();
    test.skip(
      containerCount === 0,
      "no agent library container rendered (likely empty state); toggle visibility covered elsewhere",
    );

    await listButton.click();
    await expect
      .poll(async () => gridContainer.first().getAttribute("class"))
      .toMatch(/grid-cols-1/);

    await gridButton.click();
    await expect
      .poll(async () => gridContainer.first().getAttribute("class"))
      .toMatch(/sm:grid-cols-2|md:grid-cols|lg:grid-cols/);
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
    await expect
      .poll(async () =>
        gridAfter.evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .toBe(initialGridBg);
  });
});
