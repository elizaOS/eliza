/**
 * Development smoke spec for the Bun Dev Onboarding Chat Bun dev app boot
 * path.
 */
import { expect, test } from "@playwright/test";
import {
  browserFailureCollector,
  ensureOnboarded,
  LIVE_PROVIDER,
  seedCompletedFirstRunStorage,
  sendChat,
  warmUpModel,
} from "./live-onboarding";
import { resolveLiveProviderLaneVerdict } from "./required-live-provider";

const RESPONSE_MARKER = "BUN_DEV_SMOKE_OK";

const offlineLane = process.env.ELIZA_DEV_SMOKE_OFFLINE === "1";
const laneVerdict = resolveLiveProviderLaneVerdict({
  providerConfigured: Boolean(LIVE_PROVIDER),
  offlineLane,
  required: process.env.CI === "1" || process.env.CI === "true",
});

test.skip(!offlineLane, "runs only through test:dev-smoke:local");

// The required hosted local lane must not pass by skipping. Register an explicit
// failing test when no supported provider credential is available; a local
// keyless developer keeps the optional skip below.
if (laneVerdict.action === "fail") {
  test("requires a supported live provider credential", () => {
    throw new Error(laneVerdict.reason);
  });
}

test.describe("bun run dev onboarding chat smoke", () => {
  test.describe.configure({ retries: process.env.CI ? 1 : 0 });

  test.skip(
    laneVerdict.action !== "run",
    laneVerdict.action === "skip"
      ? laneVerdict.reason
      : "live provider unavailable",
  );

  test("starts dev, completes onboarding, and sends a chat message", async ({
    page,
  }) => {
    const failureCollector = browserFailureCollector(page);

    // Onboarding submission runs here (or in a sibling spec sharing this dev
    // server, whichever runs first); ensureOnboarded is idempotent.
    await ensureOnboarded();

    await seedCompletedFirstRunStorage(page);
    await page.goto("/");

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

    expect(
      await failureCollector.failures(),
      "browser/runtime failures",
    ).toEqual([]);
  });
});
