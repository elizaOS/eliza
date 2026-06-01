import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

// Two independent clients (separate browser contexts => separate localStorage /
// cookies) connected to the SAME agent must converge on the same conversation
// state: a message sent by client A must appear for client B, and vice versa.
//
// SKIPPED (test.fixme) — documented reason:
// The default ui-smoke route layer (installDefaultAppRoutes in ./helpers.ts,
// single `page` arg) wires a deterministic *keyless* agent that echoes a fresh
// JSON fixture per request; it does NOT maintain a shared, server-side message
// log across clients. Each Playwright context also installs its own page.route
// mocks, so there is no shared backing store for A's message to reach B. With
// no shared messaging backend (or a real live stack with one agent + one
// channel both clients subscribe to), there is no honest convergence to assert
// here — only a no-op that would trivially pass.
//
// Activation checklist:
//   1. Run against a real shared backend (e.g. ELIZA_UI_SMOKE_LIVE_STACK=1 with
//      both contexts pointed at the same agent + channel), OR extend the helper
//      route layer to accept a shared in-memory message store both contexts
//      mutate (see installDefaultAppRoutes in ./helpers.ts).
//   2. Replace `test.fixme` with `test`.

const READY_SELECTOR = '[data-testid="chat-composer-textarea"]';
const COMPOSER = '[data-testid="chat-composer-textarea"]';
const ACTION = '[data-testid="chat-composer-action"]';
// useMessaging polls the shared channel; give convergence comfortable headroom.
const CONVERGE_TIMEOUT_MS = 15_000;

async function openClient(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/chat");
  await expect(page.locator(READY_SELECTOR)).toBeVisible({ timeout: 60_000 });
  return page;
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.locator(COMPOSER).fill(text);
  await expect(page.locator(ACTION)).toBeEnabled();
  await page.locator(ACTION).click();
  // The sender renders its own message immediately.
  await expect(
    page
      .locator('[data-testid="chat-message"][data-role="user"]')
      .filter({ hasText: text })
      .last(),
  ).toBeVisible({ timeout: 30_000 });
}

test.fixme("two clients on the same agent converge and do not desync", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  try {
    const clientA = await openClient(contextA);
    const clientB = await openClient(contextB);

    const fromA = "ping from client A";
    const fromB = "pong from client B";

    // A sends; B (polling the shared channel) must observe it.
    await sendMessage(clientA, fromA);
    await expect(
      clientB
        .locator('[data-testid="chat-message"]')
        .filter({ hasText: fromA }),
    ).toBeVisible({ timeout: CONVERGE_TIMEOUT_MS });

    // B sends; A must observe it.
    await sendMessage(clientB, fromB);
    await expect(
      clientA
        .locator('[data-testid="chat-message"]')
        .filter({ hasText: fromB }),
    ).toBeVisible({ timeout: CONVERGE_TIMEOUT_MS });

    // Both clients must end on the same visible message set (no desync).
    const readMessages = (page: Page): Promise<string[]> =>
      page
        .locator('[data-testid="chat-message"]')
        .allInnerTexts()
        .then((texts) => texts.map((t) => t.trim()).filter(Boolean));

    await expect
      .poll(() => readMessages(clientA), { timeout: CONVERGE_TIMEOUT_MS })
      .toEqual(await readMessages(clientB));
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
