// Browser coverage for the slash-command surface — the real web chat composer
// (ContinuousChatOverlay) fetching GET /api/commands, rendering the slash menu,
// and dispatching each target kind through useSlashCommandController. The
// component-level dispatch wiring is asserted in
// packages/ui/src/components/shell/ContinuousChatOverlay.slash.test.tsx; this
// proves the same path end to end in a real browser over a real catalog fetch.
//
// The default smoke stub serves an EMPTY command catalog (a fresh agent), so
// this spec overrides GET /api/commands with a representative catalog covering
// all three target kinds (navigate / client / agent). Keyless against the stub.

import { expect, test } from "@playwright/test";
import {
  touchSwipe,
  touchTap,
} from "../../../ui/src/testing/real-touch-gestures";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const SLASH_CATALOG = {
  commands: [
    {
      key: "settings",
      nativeName: "settings",
      description: "Open agent settings",
      textAliases: ["/settings"],
      scope: "both",
      acceptsArgs: false,
      args: [],
      requiresAuth: false,
      requiresElevated: false,
      target: { kind: "navigate", tab: "settings", path: "/settings" },
      source: "builtin",
    },
    {
      key: "clear",
      nativeName: "clear",
      description: "Clear the current chat",
      textAliases: ["/clear"],
      scope: "both",
      acceptsArgs: false,
      args: [],
      requiresAuth: false,
      requiresElevated: false,
      target: { kind: "client", clientAction: "clear-chat" },
      source: "builtin",
    },
    {
      key: "help",
      nativeName: "help",
      description: "Show available commands",
      textAliases: ["/help"],
      scope: "both",
      acceptsArgs: false,
      args: [],
      requiresAuth: false,
      requiresElevated: false,
      target: { kind: "agent" },
      source: "builtin",
    },
  ],
  surface: "gui",
  agentId: null,
  generatedAt: "2026-01-01T00:00:00.000Z",
};

test.beforeEach(async ({ page }) => {
  // Opt out of the first-run tour so its spotlight doesn't cover the composer.
  await seedAppStorage(page, { "eliza:tutorial-autolaunched": "1" });
  await installDefaultAppRoutes(page);
  // Override the empty default catalog with a representative one. Registered
  // after the defaults so this handler wins (Playwright matches LIFO).
  await page.route("**/api/commands**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const surface = new URL(route.request().url()).searchParams.get("surface");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...SLASH_CATALOG, surface }),
    });
  });
});

test("slash menu: typing / lists the catalog commands and filters by token", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeVisible({ timeout: 60_000 });

  await composer.fill("/");
  const menu = page.getByTestId("slash-command-menu");
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await expect(menu).toContainText("/settings");
  await expect(menu).toContainText("/clear");
  await expect(menu).toContainText("/help");

  // The typed token narrows the menu to the matching command.
  await composer.fill("/set");
  await expect(menu).toContainText("/settings");
  await expect(menu).not.toContainText("/help");

  // Escape dismisses the menu but keeps the draft (a real, non-destructive exit).
  await composer.press("Escape");
  await expect(menu).toBeHidden();
  await expect(composer).toHaveValue("/set");
});

/**
 * Count outgoing chat sends (POST to the conversation message endpoint). This is
 * the robust differential between an agent command (which sends) and a
 * navigate/client command (which is consumed locally) — focusing the composer
 * springs the pull-up chat open regardless of send, so `data-open` cannot tell
 * them apart, but the network does.
 */
function trackChatSends(page: import("@playwright/test").Page): () => number {
  let sends = 0;
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    if (
      /\/api\/conversations\/[^/]+\/messages(?:\/stream)?(?:\?|$)/.test(
        req.url(),
      )
    ) {
      sends += 1;
    }
  });
  return () => sends;
}

test("slash menu: an agent command sends through the chat pipeline", async ({
  page,
}) => {
  const sendCount = trackChatSends(page);
  await openAppPath(page, "/chat");
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeVisible({ timeout: 60_000 });

  await composer.fill("/help");
  await expect(page.getByTestId("slash-command-menu")).toBeVisible();
  // Enter on an agent-target command routes the text through the message
  // pipeline — a real chat send fires.
  await composer.press("Enter");
  await expect.poll(() => sendCount(), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(composer).toHaveValue("");
});

test("slash menu: a client command runs locally without sending a message", async ({
  page,
}) => {
  const sendCount = trackChatSends(page);
  await openAppPath(page, "/chat");
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeVisible({ timeout: 60_000 });

  await composer.fill("/clear");
  await expect(page.getByTestId("slash-command-menu")).toBeVisible();
  // A client command (clear-chat) consumes the draft and runs locally — it must
  // NOT post a chat message.
  await composer.press("Enter");
  await expect(page.getByTestId("slash-command-menu")).toBeHidden();
  await expect(composer).toHaveValue("");
  // Give any (erroneous) send a chance to fire, then assert none did.
  await page.waitForTimeout(500);
  expect(sendCount()).toBe(0);
});

test("slash menu: a navigate command consumes the draft instead of sending it", async ({
  page,
}) => {
  const sendCount = trackChatSends(page);
  await openAppPath(page, "/chat");
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeVisible({ timeout: 60_000 });

  await composer.fill("/settings");
  await expect(page.getByTestId("slash-command-menu")).toBeVisible();
  // A navigate command resolves to an in-app destination; it is consumed, not
  // sent as chat.
  await composer.press("Enter");
  await expect(page.getByTestId("slash-command-menu")).toBeHidden();
  await expect(composer).toHaveValue("");
  await page.waitForTimeout(500);
  expect(sendCount()).toBe(0);
});

// ---------------------------------------------------------------------------
// #10722 — real-pointer gesture coverage for SlashCommandMenu. The menu is an
// overflow-y-auto listbox floating over the composer; its pick contract is:
//   - pointer-down only guards mouse/pen composer focus (preventDefault, no pick),
//   - the pick itself fires on click, so the engine's own tap-vs-scroll
//     discrimination applies (a scroll gesture never emits click).
// These tests drive genuine engine input — Playwright mouse (both engines) and
// CDP Input.dispatchTouchEvent real-touch (Chromium) — NOT synthetic
// dispatchEvent. With the previous pointer-down pick, the drag tests below
// executed a command the instant the gesture touched a row.
// ---------------------------------------------------------------------------

test("slash menu pointer: a real mouse click picks the option and the composer keeps focus", async ({
  page,
}) => {
  const sendCount = trackChatSends(page);
  await openAppPath(page, "/chat");
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeVisible({ timeout: 60_000 });

  await composer.fill("/cl");
  const menu = page.getByTestId("slash-command-menu");
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("slash-option-0")).toContainText("/clear");

  // Real mouse click on the option row: the client command executes (menu
  // closes, draft consumed, no chat send) and — because pointer-down only
  // prevents the focus steal — the composer never loses focus to the button.
  await page.getByTestId("slash-option-0").click();
  await expect(menu).toBeHidden();
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  await page.waitForTimeout(500);
  expect(sendCount()).toBe(0);
});

test("slash menu pointer: a mouse press that drags off the option and releases elsewhere never picks", async ({
  page,
}) => {
  const sendCount = trackChatSends(page);
  await openAppPath(page, "/chat");
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeVisible({ timeout: 60_000 });

  await composer.fill("/");
  const menu = page.getByTestId("slash-command-menu");
  await expect(menu).toBeVisible();

  const option = page.getByTestId("slash-option-0");
  const box = await option.boundingBox();
  if (!box) throw new Error("slash-option-0 has no bounding box");

  // Press ON the row, drag well outside the menu, release there. click targets
  // the press/release common ancestor (not the button), so no pick may fire —
  // the pointer-down-pick regression this guards against executed /settings
  // right here.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Handler-liveness gate (kills the hydration race): the hover highlight is
  // driven by a React handler, so data-active proves listeners are attached
  // before the press — a press into un-hydrated UI would vacuously "not pick".
  await expect(option).toHaveAttribute("data-active", "true");
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 160, { steps: 8 });
  await page.mouse.up();

  await expect(menu).toBeVisible();
  await expect(composer).toHaveValue("/");
  await page.waitForTimeout(500);
  expect(sendCount()).toBe(0);
});

/** A catalog long enough to overflow the menu's max-height (agent-kind, so a
 *  mis-fired pick is loudly observable as a chat send). */
const LONG_SLASH_CATALOG = {
  ...SLASH_CATALOG,
  commands: Array.from({ length: 24 }, (_, i) => ({
    key: `bulk${String(i).padStart(2, "0")}`,
    nativeName: `bulk${String(i).padStart(2, "0")}`,
    description: `Bulk agent command ${i}`,
    textAliases: [`/bulk${String(i).padStart(2, "0")}`],
    scope: "both",
    acceptsArgs: false,
    args: [],
    requiresAuth: false,
    requiresElevated: false,
    target: { kind: "agent" },
    source: "builtin",
  })),
};

test.describe("slash menu real-touch gestures (#10722)", () => {
  test.use({ hasTouch: true });

  test("a real touch tap on an option executes the pick", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "CDP Input.dispatchTouchEvent is Chromium-only; WebKit runs the real-mouse pointer tests above",
    );
    const sendCount = trackChatSends(page);
    await openAppPath(page, "/chat");
    const composer = page.getByTestId("chat-composer-textarea");
    await expect(composer).toBeVisible({ timeout: 60_000 });

    await composer.fill("/cl");
    const menu = page.getByTestId("slash-command-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("slash-option-0")).toContainText("/clear");

    // Handler-liveness gate (see the mouse drag-off test).
    await page.getByTestId("slash-option-0").hover();
    await expect(page.getByTestId("slash-option-0")).toHaveAttribute(
      "data-active",
      "true",
    );

    // Genuine finger tap (touchStart → touchEnd, no movement). The pick moved
    // from pointer-down to click, and touch keeps the platform default so
    // WebKit-style touch-generated clicks are not suppressed.
    await touchTap(page, '[data-testid="slash-option-0"]');
    await expect(menu).toBeHidden();
    await expect(composer).toHaveValue("");
    await page.waitForTimeout(500);
    expect(sendCount()).toBe(0);
  });

  test("a touch drag starting on an option row scrolls the overflowing menu and never executes a command", async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "CDP Input.dispatchTouchEvent is Chromium-only; WebKit runs the real-mouse pointer tests above",
    );
    const sendCount = trackChatSends(page);
    // LIFO route override: a 24-command agent catalog so the listbox overflows.
    await page.route("**/api/commands**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(LONG_SLASH_CATALOG),
      });
    });
    await openAppPath(page, "/chat");
    const composer = page.getByTestId("chat-composer-textarea");
    await expect(composer).toBeVisible({ timeout: 60_000 });

    await composer.fill("/");
    const menu = page.getByTestId("slash-command-menu");
    await expect(menu).toBeVisible();
    await expect(page.getByTestId("slash-option-23")).toBeAttached();

    // Precondition: the listbox genuinely overflows (otherwise this test is
    // vacuous — nothing to scroll).
    const overflow = await menu.evaluate(
      (el) => el.scrollHeight - el.clientHeight,
    );
    expect(overflow).toBeGreaterThan(40);

    // Handler-liveness gate (see the mouse drag-off test).
    await page.getByTestId("slash-option-1").hover();
    await expect(page.getByTestId("slash-option-1")).toHaveAttribute(
      "data-active",
      "true",
    );

    // Finger lands ON an option row and drags upward — a scroll gesture, not a
    // tap. The listbox must scroll; NO command may execute (the old
    // pointer-down pick sent /bulk01 the instant the finger touched the row).
    // Bounded retry: scroll-chain arbitration can eat a first gesture right
    // after mount, but the no-pick invariant is re-asserted after EVERY
    // attempt — a pick-on-pointer-down regression closes the menu/clears the
    // draft on attempt 1 and fails these asserts loudly, retry or not.
    let scrolled = 0;
    for (let attempt = 0; attempt < 3 && scrolled === 0; attempt += 1) {
      await touchSwipe(page, '[data-testid="slash-option-1"]', 0, -140, {
        steps: 10,
        stepDelayMs: 16,
      });
      await expect(menu).toBeVisible();
      await expect(composer).toHaveValue("/");
      expect(sendCount()).toBe(0);
      await page.waitForTimeout(250);
      scrolled = await menu.evaluate((el) => el.scrollTop);
    }
    expect(scrolled).toBeGreaterThan(0);
    await expect(menu).toBeVisible();
    await expect(composer).toHaveValue("/");
    await page.waitForTimeout(500);
    expect(sendCount()).toBe(0);
  });
});
