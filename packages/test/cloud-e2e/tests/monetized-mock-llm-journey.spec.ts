/**
 * Creator-monetization journey — KEYLESS mock-LLM variant (#9477).
 *
 * The marquee `creator-monetization-journey.spec.ts` proves the real revenue
 * loop but is gated behind `CEREBRAS_API_KEY` and skips silently otherwise, so
 * no always-on run exercises the `POST /api/v1/messages` + `x-app-id` billing
 * seam. This spec closes that gap: it boots the stack with an in-process
 * OpenAI-compatible mock LLM (`mockLlm` stack option → `OPENAI_BASE_URL`), then
 * drives the SAME loop against an `openai/<model>` id — register → monetize →
 * independent end-user pays via real inference billing → end-user org is
 * debited → the creator earns the computed markup → it lands in the redeemable
 * balance. Only the LLM bytes are mocked; the credits/markup/earnings path is
 * fully real and runs without any paid key.
 */

import { appsRepository } from "@elizaos/cloud-shared/db/repositories/apps";
import { seedTestUser } from "../src/fixtures/seed";
import { authedClient } from "../src/helpers/monetization";
import { seedModelPricing } from "../src/helpers/seed-pricing";
import { expect, test } from "../src/helpers/test-fixtures";

// API-only stack with the mock LLM wired into the worker's OPENAI_BASE_URL.
test.use({ stackOptions: { frontend: false, mockLlm: true } });

// `openai/<model>` → isOpenAINativeModel → getOpenAIClient().chat() honours
// OPENAI_BASE_URL → the mock. resolveAiProviderSource bills it to `openai`,
// which the seeded `openai`-source pricing row short-circuits (no BitRouter).
const MODEL = "openai/gpt-4o-mini";

interface CreateAppResponse {
  success?: boolean;
  app?: { id?: string };
  apiKey?: string;
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface BalanceResponse {
  balance?: number;
}

test.describe("creator-monetization journey (mock LLM, keyless)", () => {
  test("creator monetizes an app → end-user pays via mock inference → creator earns", async ({
    stack,
    seededUser,
  }) => {
    const api = stack.urls.api;
    expect(
      stack.urls.mockLlm,
      "stack booted with the mock LLM wired in",
    ).toBeTruthy();

    await seedModelPricing({
      model: MODEL,
      billingSource: "openai",
      provider: "openai",
    });

    // ---- Creator (org A) ----
    const creator = authedClient(api, seededUser.apiKey);

    const created = await creator<CreateAppResponse>("POST", "/api/v1/apps", {
      name: `Mock Journey App ${Date.now().toString(36)}`,
      app_url: "https://placeholder.invalid",
      skipGitHubRepo: true,
    });
    expect([200, 201]).toContain(created.status);
    const appId = created.json.app?.id;
    expect(appId, "apps.create returns an app id").toBeTruthy();
    if (!appId) throw new Error("apps.create did not return an app id");

    const draftMonetize = await creator(
      "PUT",
      `/api/v1/apps/${appId}/monetization`,
      {
        monetizationEnabled: true,
        inferenceMarkupPercentage: 100,
        purchaseSharePercentage: 10,
      },
    );
    expect(
      draftMonetize.status,
      "draft app cannot enable monetization before compliance approval",
    ).toBe(403);
    await approveAppForMockJourney(appId);

    const monetize = await creator(
      "PUT",
      `/api/v1/apps/${appId}/monetization`,
      {
        monetizationEnabled: true,
        inferenceMarkupPercentage: 100,
        purchaseSharePercentage: 10,
      },
    );
    expect([200, 201]).toContain(monetize.status);

    // ---- Independent end-user (org B) ----
    const endUser = await seedTestUser({
      slug: `mockenduser-${Date.now().toString(36)}`,
    });
    const buyer = authedClient(api, endUser.apiKey);

    const balBefore = await buyer<BalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
    );
    expect(balBefore.status).toBe(200);
    const beforeBalance = balBefore.json.balance ?? 0;
    expect(beforeBalance).toBeGreaterThan(0);

    // Creator earnings BEFORE the paid inference.
    const { redeemableEarningsService } = await import(
      "@elizaos/cloud-shared/lib/services/redeemable-earnings"
    );
    const { appEarningsService } = await import(
      "@elizaos/cloud-shared/lib/services/app-earnings"
    );
    const creatorEarnBefore =
      (await redeemableEarningsService.getBalance(seededUser.userId))
        ?.availableBalance ?? 0;
    const appEarnBefore =
      (await appEarningsService.getEarningsSummary(appId))
        ?.totalLifetimeEarnings ?? 0;

    // ---- Paid inference: end-user calls the monetized app (mock LLM) ----
    const inference = await buyer<MessagesResponse>(
      "POST",
      "/api/v1/messages",
      {
        model: MODEL,
        max_tokens: 256,
        messages: [
          { role: "user", content: "Reply with exactly the word: PONG" },
        ],
      },
      { "X-App-Id": appId },
    );
    expect(inference.status, "monetized inference returns 200").toBe(200);
    const text =
      inference.json.content?.find((b) => b.type === "text")?.text ?? "";
    expect(text, "mock LLM returned the deterministic completion").toBe("PONG");
    expect(
      (inference.json.usage?.output_tokens ?? 0) > 0,
      "token usage reported",
    ).toBe(true);

    // The mock actually served the request (the billing seam was exercised).
    expect(
      stack.mocks.mockLlm?.requestCount() ?? 0,
      "the mock LLM served the inference",
    ).toBeGreaterThan(0);

    // ---- End-user org was debited (base + markup) ----
    const balAfter = await buyer<BalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
    );
    expect(balAfter.status).toBe(200);
    const afterBalance = balAfter.json.balance ?? 0;
    const debited = beforeBalance - afterBalance;
    console.log(
      `[mock-journey] end-user debited ${debited} (before=${beforeBalance} after=${afterBalance})`,
    );
    expect(
      debited,
      "mock inference debited the end-user's org credits",
    ).toBeGreaterThan(0);

    // ---- Creator earned the markup (both ledgers) ----
    const creatorEarnAfter =
      (await redeemableEarningsService.getBalance(seededUser.userId))
        ?.availableBalance ?? 0;
    const appEarnAfter =
      (await appEarningsService.getEarningsSummary(appId))
        ?.totalLifetimeEarnings ?? 0;
    console.log(
      `[mock-journey] creator redeemable ${creatorEarnBefore}->${creatorEarnAfter}, app_earnings ${appEarnBefore}->${appEarnAfter}`,
    );
    expect(
      creatorEarnAfter + appEarnAfter,
      "creator earnings increased from the paid inference",
    ).toBeGreaterThan(creatorEarnBefore + appEarnBefore);

    // ---- Creator reads earnings + redeemable balance via the API ----
    const earningsApi = await creator<{
      success?: boolean;
      earnings?: { summary?: { totalLifetimeEarnings?: number } };
    }>("GET", `/api/v1/apps/${appId}/earnings`);
    expect(earningsApi.status).toBe(200);
    expect(earningsApi.json.success).toBe(true);

    const redeemBal = await creator<{ success?: boolean }>(
      "GET",
      "/api/v1/redemptions/balance",
    );
    expect(redeemBal.status).toBe(200);
  });
});

async function approveAppForMockJourney(appId: string): Promise<void> {
  // This spec validates billing + creator earnings, not the live review model.
  // Use the deterministic grandfathered approval used by the other monetization
  // e2e suites so the money path can run after proving the draft gate is closed.
  await appsRepository.update(appId, {
    review_status: "approved",
    review_content_hash: null,
    reviewed_at: new Date(),
  });
}
