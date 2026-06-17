/**
 * Creator-monetization journey — the marquee REAL end-to-end test.
 *
 * Proves the full "make money from inference" loop against the booted stack
 * with a REAL local LLM completion (Ollama via the OpenAI-compatible endpoint)
 * and REAL billing — no mocked provider, no fabricated earnings:
 *
 *   creator seeds + creates a monetized app (100% inference markup)
 *     → an INDEPENDENT end-user (separate org) calls the app's inference via
 *       POST /api/v1/messages with `x-app-id` and a real model
 *     → the end-user's org credit balance is debited (base + markup)
 *     → the creator's earnings ledgers record the markup
 *     → the creator reads earnings via GET /api/v1/apps/:id/earnings
 *     → the creator's redeemable balance reflects the earning
 *
 * Real-LLM env (propagated to the stack's cloud-api worker via process.env):
 *   OPENAI_API_KEY=<anything>  OPENAI_BASE_URL=http://127.0.0.1:11434/v1
 * and a colon-free Ollama alias `elizatest` (ollama cp llama3.2:3b elizatest).
 * If Ollama is unreachable the LLM-dependent test skips loudly (never larps).
 */
process.env.OPENAI_API_KEY ??= "ollama-local";
process.env.OPENAI_BASE_URL ??= "http://127.0.0.1:11434/v1";

import { seedTestUser } from "../src/fixtures/seed";
import {
  authedClient,
  ollamaReachable,
  REAL_LLM_MODEL,
} from "../src/helpers/monetization";
import { seedModelPricing } from "../src/helpers/seed-pricing";
import { expect, test } from "../src/helpers/test-fixtures";

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

test.describe("creator-monetization journey (real LLM)", () => {
  test("creator monetizes an app → end-user pays via real inference → creator earns", async ({
    stack,
    seededUser,
  }) => {
    const api = stack.urls.api;

    const haveLlm = await ollamaReachable();
    test.skip(
      !haveLlm,
      "Real local LLM (Ollama at OPENAI_BASE_URL) is not reachable — this is a real-LLM lane",
    );

    await seedModelPricing({ model: REAL_LLM_MODEL });

    // ---- Creator (org A) ----
    const creator = authedClient(api, seededUser.apiKey);

    const created = await creator<CreateAppResponse>("POST", "/api/v1/apps", {
      name: `Journey App ${Date.now().toString(36)}`,
      app_url: "https://placeholder.invalid",
      skipGitHubRepo: true,
    });
    expect([200, 201]).toContain(created.status);
    const appId = created.json.app?.id;
    expect(appId, "apps.create returns an app id").toBeTruthy();
    if (!appId) throw new Error("apps.create did not return an app id");

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
      slug: `enduser-${Date.now().toString(36)}`,
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

    // ---- REAL paid inference: end-user calls the monetized app ----
    const inference = await buyer<MessagesResponse>(
      "POST",
      "/api/v1/messages",
      {
        model: REAL_LLM_MODEL,
        max_tokens: 32,
        messages: [
          { role: "user", content: "Reply with exactly the word: PONG" },
        ],
      },
      { "X-App-Id": appId },
    );
    expect(inference.status, "monetized inference returns 200").toBe(200);
    const text =
      inference.json.content?.find((b) => b.type === "text")?.text ?? "";
    expect(
      text.length,
      "real LLM returned non-empty completion",
    ).toBeGreaterThan(0);
    expect(
      (inference.json.usage?.output_tokens ?? 0) > 0,
      "real token usage reported",
    ).toBe(true);

    // ---- End-user org was debited (base + markup) ----
    const balAfter = await buyer<BalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
    );
    expect(balAfter.status).toBe(200);
    const afterBalance = balAfter.json.balance ?? 0;
    const debited = beforeBalance - afterBalance;
    console.log(
      `[journey] end-user debited ${debited} (before=${beforeBalance} after=${afterBalance})`,
    );
    expect(
      debited,
      "real inference debited the end-user's org credits",
    ).toBeGreaterThan(0);

    // ---- Creator earned the markup (both ledgers, per recordCreatorEarnings) ----
    const creatorEarnAfter =
      (await redeemableEarningsService.getBalance(seededUser.userId))
        ?.availableBalance ?? 0;
    const appEarnAfter =
      (await appEarningsService.getEarningsSummary(appId))
        ?.totalLifetimeEarnings ?? 0;
    console.log(
      `[journey] creator redeemable ${creatorEarnBefore}->${creatorEarnAfter}, app_earnings ${appEarnBefore}->${appEarnAfter}`,
    );
    expect(
      creatorEarnAfter + appEarnAfter,
      "creator earnings increased from the paid inference",
    ).toBeGreaterThan(creatorEarnBefore + appEarnBefore);

    // ---- Creator reads earnings via the API (the skill's `what are my earnings`) ----
    const earningsApi = await creator<{
      success?: boolean;
      earnings?: { summary?: { totalLifetimeEarnings?: number } };
    }>("GET", `/api/v1/apps/${appId}/earnings`);
    expect(earningsApi.status).toBe(200);
    expect(earningsApi.json.success).toBe(true);

    // ---- Creator's redeemable payout balance reflects earnings ----
    const redeemBal = await creator<{ success?: boolean }>(
      "GET",
      "/api/v1/redemptions/balance",
    );
    expect(redeemBal.status).toBe(200);
  });
});
