import { expect, test } from "@playwright/test";
import {
  browserFailureCollector,
  ensureOnboarded,
  LIVE_PROVIDER,
  seedCompletedFirstRunStorage,
  sendChat,
  warmUpModel,
} from "./live-onboarding";

const RESPONSE_MARKER = "BUN_DEV_SMOKE_OK";

test.describe("bun run dev onboarding chat smoke", () => {
  test.skip(!LIVE_PROVIDER, "set a supported live provider key for dev smoke");

  test("starts dev, completes onboarding, and sends a chat message", async ({
    page,
  }) => {
    const failures = browserFailureCollector(page);

    // Onboarding submission runs here (or in a sibling spec sharing this dev
    // server, whichever runs first); ensureOnboarded is idempotent.
    await ensureOnboarded();

    await seedCompletedFirstRunStorage(page);
    await page.goto("/");
    await seedCompletedFirstRunStorage(page);

    // Wait until the deferred model provider is registered and produces a real
    // reply, so the asserted turn below is not racing plugin boot.
    await warmUpModel(page);

    const prompt = `For a CI smoke test, reply with exactly ${RESPONSE_MARKER} and no other words.`;
    await sendChat(page, prompt);

    // Assert the AGENT's reply contains the marker — NOT the whole conversation
    // log, which also contains the user's own prompt ("reply with exactly
    // <MARKER>"). Matching the log would pass even when the agent never responds
    // (e.g. no model provider registered), which is a false green. The reply must
    // come from a `data-role="assistant"` thread line produced by a real model.
    const assistantReply = page
      .locator('[data-testid="thread-line"][data-role="assistant"]')
      .filter({ hasText: RESPONSE_MARKER });
    await expect(assistantReply.first()).toBeVisible({ timeout: 180_000 });

    expect(failures, "browser/runtime failures").toEqual([]);
  });
});
