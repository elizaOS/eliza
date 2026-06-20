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
