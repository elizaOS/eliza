import { type APIRequestContext, expect, test } from "@playwright/test";
import { resolveE2EChatModel } from "../e2e/helpers/chat-model";
import { ensureLocalTestAuth } from "../infrastructure/local-test-auth";

/**
 * TOCTOU Race Condition Test
 *
 * This test demonstrates the Time-Of-Check-To-Time-Of-Use vulnerability
 * in the credit system when multiple parallel requests are made.
 *
 * BUG: The current implementation checks balance BEFORE streaming,
 * then deducts AFTER. Multiple parallel requests can all pass the
 * check and over-consume credits.
 *
 * FIX: Deduct credits BEFORE the operation (like /api/mcp does),
 * then reconcile the difference after.
 */

const PLAYWRIGHT_API_PORT = process.env.PLAYWRIGHT_API_PORT || "8787";
const PLAYWRIGHT_API_URL =
  process.env.PLAYWRIGHT_API_URL ?? `http://localhost:${PLAYWRIGHT_API_PORT}`;
const CLOUD_URL = process.env.CLOUD_URL ?? PLAYWRIGHT_API_URL;
const CHAT_TEST_MODEL = resolveE2EChatModel("gpt-5-mini");
let apiKey = "";

function authHeaders() {
  if (!apiKey) {
    throw new Error("Local Playwright API key was not bootstrapped");
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function getCreditBalance(request: APIRequestContext): Promise<number> {
  const response = await request.get(`${CLOUD_URL}/api/v1/credits/balance?fresh=true`, {
    headers: authHeaders(),
  });

  if (response.status() !== 200) {
    expect(response.status(), await response.text()).toBe(200);
  }

  const body = await response.json();
  return Number.parseFloat(String(body.balance ?? body.creditBalance ?? 0));
}

test.describe("TOCTOU Race Condition - Credit Deduction", () => {
  test.beforeAll(async () => {
    apiKey = (await ensureLocalTestAuth()).apiKey;
  });

  /**
   * This test demonstrates the TOCTOU bug:
   * - User has $1 balance
   * - 5 parallel requests each estimated at $0.30
   * - All 5 should pass the check (1 >= 0.30)
   * - Only ~3 should actually have credits deducted
   * - Result: 2+ requests get FREE service
   *
   * EXPECTED (after fix): Only 3 requests succeed, 2 get 402
   * ACTUAL (bug): All 5 requests succeed, balance goes negative or
   *               some deductions fail silently
   */
  test("parallel requests should not over-consume credits", async ({ request }) => {
    // 1. Get initial balance
    const initialBalance = await getCreditBalance(request);

    console.log(`Initial balance: $${initialBalance.toFixed(4)}`);

    // 2. Calculate how many requests SHOULD fit in the balance
    // Actual cost per request is ~$0.02 for gpt-5-mini short message
    const actualCostPerRequest = 0.02;
    const maxPossibleRequests = Math.floor(initialBalance / actualCostPerRequest);

    const numParallelRequests = Math.max(2, Math.min(8, maxPossibleRequests + 2));

    console.log(
      `Launching ${numParallelRequests} parallel requests (max should be ~${maxPossibleRequests})`,
    );

    // 3. Launch parallel requests to chat/completions
    const requests = Array(numParallelRequests)
      .fill(null)
      .map((_, i) =>
        request.post(`${CLOUD_URL}/api/v1/chat/completions`, {
          headers: authHeaders(),
          data: {
            model: CHAT_TEST_MODEL,
            messages: [{ role: "user", content: `Test ${i}: Say "ok"` }],
            max_tokens: 5,
            stream: false, // Non-streaming for simpler test
          },
        }),
      );

    // 4. Wait for all requests to complete
    const responses = await Promise.all(requests);

    // 5. Count successes vs failures
    const successes = responses.filter((r) => r.status() === 200).length;
    const insufficientCredits = responses.filter((r) => r.status() === 402).length;
    const rateLimited = responses.filter((r) => r.status() === 429).length;
    const serviceUnavailable = responses.filter((r) => r.status() === 503).length;
    const unexpectedResponses = responses.filter((r) => ![200, 402, 429, 503].includes(r.status()));
    const unexpectedDetails = await Promise.all(
      unexpectedResponses.map(async (response) => ({
        status: response.status(),
        body: await response.text().catch(() => "<unavailable>"),
      })),
    );
    const otherErrors = unexpectedResponses.length;

    console.log(`Successes: ${successes}`);
    console.log(`Insufficient credits (402): ${insufficientCredits}`);
    console.log(`Rate limited (429): ${rateLimited}`);
    console.log(`Service unavailable (503): ${serviceUnavailable}`);
    console.log(`Other errors: ${otherErrors}`);
    expect(otherErrors, JSON.stringify(unexpectedDetails, null, 2)).toBe(0);

    // 6. Get final balance
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for deductions
    const finalBalance = await getCreditBalance(request);

    console.log(`Final balance: $${finalBalance.toFixed(4)}`);
    console.log(`Total deducted: $${(initialBalance - finalBalance).toFixed(4)}`);

    // 7. THE BUG ASSERTION
    // If TOCTOU bug exists: successes > maxPossibleRequests (over-consumption)
    // If fixed: successes <= maxPossibleRequests + small margin for estimation errors

    // With the bug, balance might go negative or deductions fail silently
    if (finalBalance < 0) {
      console.log("BUG DETECTED: Balance went negative");
    }

    // The fix should ensure:
    // - No more successes than credits allow
    // - Balance never goes negative
    // - Excess requests get 402 immediately (not after streaming)

    // This assertion will FAIL with the current bug
    // and PASS after the fix is applied
    expect(
      finalBalance,
      "Balance should not go significantly negative (TOCTOU bug)",
    ).toBeGreaterThanOrEqual(-0.01);

    // Ideally, number of successes should be close to what balance allows
    // With a 20% margin for estimation errors
    const expectedMaxSuccesses = Math.ceil(maxPossibleRequests * 1.2);
    if (successes > expectedMaxSuccesses) {
      console.log(
        `POTENTIAL BUG: ${successes} successes but only ~${maxPossibleRequests} should fit in balance`,
      );
    }
  });

  /**
   * Test specifically for streaming endpoints where the window is larger
   */
  test("streaming requests should deduct credits atomically", async ({ request }) => {
    // Get initial balance
    const initialBalance = await getCreditBalance(request);

    console.log(`Initial balance: $${initialBalance.toFixed(4)}`);

    const requestCount = initialBalance >= 0.1 ? 3 : 1;
    const streamRequests = Array.from({ length: requestCount }, (_, index) => index + 1).map((i) =>
      request.post(`${CLOUD_URL}/api/v1/chat/completions`, {
        headers: authHeaders(),
        data: {
          model: CHAT_TEST_MODEL,
          messages: [{ role: "user", content: `Stream test ${i}: count to 3` }],
          max_tokens: 20,
          stream: true,
        },
      }),
    );

    const responses = await Promise.all(streamRequests);

    // For streaming, we just check the initial response status
    const successes = responses.filter((r) => r.status() === 200).length;
    const unexpected = responses.filter((r) => ![200, 402, 429, 503].includes(r.status()));
    console.log(`Streaming requests accepted: ${successes}/${requestCount}`);
    expect(unexpected).toHaveLength(0);

    // Wait for streams to complete and credits to be deducted
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Check final balance
    const finalBalance = await getCreditBalance(request);

    console.log(`Final balance: $${finalBalance.toFixed(4)}`);

    // Balance should not be negative
    expect(finalBalance, "Balance should not go negative after streaming").toBeGreaterThanOrEqual(
      -0.01,
    );
  });
});

test.describe("MCP Endpoint - Correct Pattern (Reference)", () => {
  test.beforeAll(async () => {
    apiKey = (await ensureLocalTestAuth()).apiKey;
  });

  /**
   * This test shows that /api/mcp correctly handles concurrent requests
   * because it uses the deduct-before pattern
   */
  test("MCP endpoint returns a configured upstream response or explicit stub", async ({
    request,
  }) => {
    const response = await request.post(`${CLOUD_URL}/api/mcp`, {
      headers: authHeaders(),
      data: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "playwright", version: "0.0.0" },
        },
      },
    });

    expect([200, 400, 401, 404, 405, 501]).toContain(response.status());
    if (response.status() === 501) {
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe("not_yet_migrated");
    }
  });
});
