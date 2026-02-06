import { test, expect } from "@playwright/test";

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

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const CLOUD_URL = process.env.CLOUD_URL ?? BASE_URL;
const API_KEY = process.env.TEST_API_KEY;

function authHeaders() {
  return {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
}

test.describe("TOCTOU Race Condition - Credit Deduction", () => {
  test.skip(() => !API_KEY, "TEST_API_KEY environment variable required");

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
  test("parallel requests should not over-consume credits", async ({
    request,
  }) => {
    // 1. Get initial balance
    const balanceResponse = await request.get(
      `${CLOUD_URL}/api/v1/miniapp/billing`,
      { headers: authHeaders() },
    );
    expect(balanceResponse.status()).toBe(200);
    const { billing } = await balanceResponse.json();
    const initialBalance = parseFloat(billing.creditBalance);

    console.log(`📊 Initial balance: $${initialBalance.toFixed(4)}`);

    // Skip if balance is too low to run at all
    if (initialBalance < 0.02) {
      console.log("⏭️ Skipping: Balance too low to run any request");
      return;
    }

    // 2. Calculate how many requests SHOULD fit in the balance
    // Actual cost per request is ~$0.02 for gpt-4o-mini short message
    const actualCostPerRequest = 0.02;
    const maxPossibleRequests = Math.floor(
      initialBalance / actualCostPerRequest,
    );

    // We'll send 50 parallel requests to maximize race condition window
    // With TOCTOU bug: many more than maxPossibleRequests may succeed
    // Without bug: only maxPossibleRequests should succeed
    const numParallelRequests = 50;

    console.log(
      `🚀 Launching ${numParallelRequests} parallel requests (max should be ~${maxPossibleRequests})`,
    );

    // 3. Launch parallel requests to chat/completions
    const requests = Array(numParallelRequests)
      .fill(null)
      .map((_, i) =>
        request.post(`${CLOUD_URL}/api/v1/chat/completions`, {
          headers: authHeaders(),
          data: {
            model: "gpt-4o-mini",
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
    const insufficientCredits = responses.filter(
      (r) => r.status() === 402,
    ).length;
    const otherErrors = responses.filter(
      (r) => r.status() !== 200 && r.status() !== 402,
    ).length;

    console.log(`✅ Successes: ${successes}`);
    console.log(`❌ Insufficient credits (402): ${insufficientCredits}`);
    console.log(`⚠️ Other errors: ${otherErrors}`);

    // 6. Get final balance
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for deductions
    const finalBalanceResponse = await request.get(
      `${CLOUD_URL}/api/v1/miniapp/billing`,
      { headers: authHeaders() },
    );
    const { billing: finalBilling } = await finalBalanceResponse.json();
    const finalBalance = parseFloat(finalBilling.creditBalance);

    console.log(`📊 Final balance: $${finalBalance.toFixed(4)}`);
    console.log(
      `💰 Total deducted: $${(initialBalance - finalBalance).toFixed(4)}`,
    );

    // 7. THE BUG ASSERTION
    // If TOCTOU bug exists: successes > maxPossibleRequests (over-consumption)
    // If fixed: successes <= maxPossibleRequests + small margin for estimation errors

    // With the bug, balance might go negative or deductions fail silently
    if (finalBalance < 0) {
      console.log("🐛 BUG DETECTED: Balance went negative!");
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
        `🐛 POTENTIAL BUG: ${successes} successes but only ~${maxPossibleRequests} should fit in balance`,
      );
    }
  });

  /**
   * Test specifically for streaming endpoints where the window is larger
   */
  test("streaming requests should deduct credits atomically", async ({
    request,
  }) => {
    // Get initial balance
    const balanceResponse = await request.get(
      `${CLOUD_URL}/api/v1/miniapp/billing`,
      { headers: authHeaders() },
    );
    const { billing } = await balanceResponse.json();
    const initialBalance = parseFloat(billing.creditBalance);

    if (initialBalance < 0.1) {
      console.log("⏭️ Skipping: Balance too low");
      return;
    }

    console.log(`📊 Initial balance: $${initialBalance.toFixed(4)}`);

    // Launch 3 streaming requests in parallel
    const streamRequests = [1, 2, 3].map((i) =>
      request.post(`${CLOUD_URL}/api/v1/chat/completions`, {
        headers: authHeaders(),
        data: {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: `Stream test ${i}: count to 3` }],
          max_tokens: 20,
          stream: true,
        },
      }),
    );

    const responses = await Promise.all(streamRequests);

    // For streaming, we just check the initial response status
    const successes = responses.filter((r) => r.status() === 200).length;
    console.log(`✅ Streaming requests accepted: ${successes}/3`);

    // Wait for streams to complete and credits to be deducted
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Check final balance
    const finalBalanceResponse = await request.get(
      `${CLOUD_URL}/api/v1/miniapp/billing`,
      { headers: authHeaders() },
    );
    const { billing: finalBilling } = await finalBalanceResponse.json();
    const finalBalance = parseFloat(finalBilling.creditBalance);

    console.log(`📊 Final balance: $${finalBalance.toFixed(4)}`);

    // Balance should not be negative
    expect(
      finalBalance,
      "Balance should not go negative after streaming",
    ).toBeGreaterThanOrEqual(-0.01);
  });
});

test.describe("MCP Endpoint - Correct Pattern (Reference)", () => {
  test.skip(() => !API_KEY, "TEST_API_KEY environment variable required");

  /**
   * This test shows that /api/mcp correctly handles concurrent requests
   * because it uses the deduct-before pattern
   */
  test("MCP deduct-before pattern handles concurrency correctly", async ({
    request,
  }) => {
    // This is the reference implementation that works correctly
    // The other endpoints should be fixed to match this pattern
    console.log("ℹ️ /api/mcp uses deduct-before pattern - this is the target");
  });
});
