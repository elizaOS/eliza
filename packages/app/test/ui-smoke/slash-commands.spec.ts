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

test("slash menu: an agent command sends through the chat pipeline", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  await expect(overlay).not.toHaveAttribute("data-open", "true");

  const composer = page.getByTestId("chat-composer-textarea");
  await composer.fill("/help");
  await expect(page.getByTestId("slash-command-menu")).toBeVisible();
  // Enter on an agent-target command routes the text through the message
  // pipeline, which springs the chat open (the same effect as pressing send).
  await composer.press("Enter");
  await expect(overlay).toHaveAttribute("data-open", "true", {
    timeout: 15_000,
  });
  await expect(composer).toHaveValue("");
});

test("slash menu: a client command runs locally without sending a message", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });

  const composer = page.getByTestId("chat-composer-textarea");
  await composer.fill("/clear");
  await expect(page.getByTestId("slash-command-menu")).toBeVisible();
  // A client command (clear-chat) consumes the draft and runs locally — it must
  // NOT send a chat message, so the collapsed overlay stays collapsed.
  await composer.press("Enter");
  await expect(page.getByTestId("slash-command-menu")).toBeHidden();
  await expect(composer).toHaveValue("");
  await expect(overlay).not.toHaveAttribute("data-open", "true");
});

test("slash menu: a navigate command consumes the draft instead of sending it", async ({
  page,
}) => {
  await openAppPath(page, "/chat");
  const overlay = page.getByTestId("continuous-chat-overlay");
  await expect(overlay).toBeVisible({ timeout: 60_000 });

  const composer = page.getByTestId("chat-composer-textarea");
  await composer.fill("/settings");
  await expect(page.getByTestId("slash-command-menu")).toBeVisible();
  // A navigate command resolves to an in-app destination; it is consumed, not
  // sent as chat, so the composer clears and no message springs the chat open.
  await composer.press("Enter");
  await expect(page.getByTestId("slash-command-menu")).toBeHidden();
  await expect(composer).toHaveValue("");
  await expect(overlay).not.toHaveAttribute("data-open", "true");
});
