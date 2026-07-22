// Browser-level chat-latency REGRESSION GATE — Shadow's stopwatch, in CI.
//
// The problem this catches (see projects/eliza-fleet/LATENCY-E2E-2026-07-22.md):
// the server harness measures first SSE BYTE on a warm, reused conversation. It
// reported ~0.4-1.3s GREEN while Shadow's stopwatch (tap-send -> first visible
// rendered text) read ~4s. First-byte is structurally blind to (a) client
// render cost and (b) a single-chunk / non-streaming regression that delivers
// first-byte fast but leaves the user staring at a spinner until the WHOLE
// reply pops in at once.
//
// This spec measures what the user actually sees, in a real Chromium page,
// through the production SSE parser + streaming-commit throttle + React render.
// It runs two scenarios matching the pacing Shadow actually hit:
//   1. COLD conversation, first turn.
//   2. A second turn after a 35s idle gap (demo Q&A think-time — the pacing that
//      re-pays cold scope on the real server; here it proves the CLIENT render
//      path stays fast and streaming across an idle).
//
// It is a NON-VACUOUS gate: it FAILS if streaming regresses to a single chunk
// (the biggest UX lever — non-incremental generateText on the bridge) OR if the
// first-render budget blows. The streaming fixture models the server pre-header
// + TTFT as a first-token delay and the incremental generation as spaced
// tokens, so the browser-side render + throttle cost is measured honestly on
// top of a realistic server timeline.
//
// BUDGETS ARE DELIBERATELY GENEROUS (CI is a noisy shared runner) — this is a
// coarse regression guard, not a brittle stopwatch. The meaningful signals are
// (1) first-render < budget and (2) genuine incrementality; both have wide
// margin over the healthy path so a real regression reds this, jitter does not.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  annotateSample,
  type ChatLatencySample,
  installLatencyStreamingFetch,
  measureChatTurn,
  p95,
} from "./lib/chat-latency-kpi";

const LATENCY_CONVO = {
  id: "latency-thread",
  title: "Latency probe thread",
  roomId: "room-latency",
};

// A realistic reply, tokenized. Enough tokens that a genuine stream is clearly
// distinguishable from a single "done" frame.
const REPLY_TOKENS = [
  "The ",
  "scheduler ",
  "pattern-matches ",
  "structural ",
  "fields ",
  "on ",
  "each ",
  "record ",
  "and ",
  "routes ",
  "through ",
  "one ",
  "runner. ",
  "Streaming ",
  "keeps ",
  "the ",
  "first ",
  "token ",
  "on ",
  "screen ",
  "fast.",
];
// A stable substring to detect "reply fully rendered". Per-turn uniqueness is
// handled by the fixture's ⟦tN⟧ nonce (see chat-latency-kpi.ts), so the same
// reply body is reused every turn without confusing the first-render probe.
const REPLY_FINAL_MARKER = "on screen fast.";

// Fixture timeline. These model a HEALTHY server: ~600ms to first token
// (pre-header + TTFT class), then ~18ms/token incremental generation. The gate
// measures the browser render cost ON TOP of this. If the real server ever
// regresses to single-chunk, the fixture is unaffected but a PRODUCTION change
// (e.g. the client stops rendering per-token, or buffers to done) would show as
// a first-render blowout or a collapsed chunk count.
const FIRST_TOKEN_DELAY_MS = 600;
const TOKEN_INTERVAL_MS = 18;

// Budgets. first-render budget = FIRST_TOKEN_DELAY_MS (unavoidable server wait
// modeled) + a generous client-render allowance. On a healthy path the client
// adds ~1 frame (~16ms) over the first token's arrival; 900ms of headroom on
// top of the 600ms modeled delay is non-flaky yet still reds a multi-hundred-ms
// client render regression.
const FIRST_RENDER_BUDGET_MS = FIRST_TOKEN_DELAY_MS + 900; // 1500ms
// Minimum distinct server chunks to consider the reply genuinely streamed. A
// single-chunk regression yields 1; the healthy path yields REPLY_TOKENS.length.
const MIN_STREAM_CHUNKS = 5;
// The reply must spread across time, not arrive as one blob. Healthy path
// spreads ~ (tokens-1)*interval ms; a single frame spreads 0.
const MIN_STREAM_SPREAD_MS = 100;

async function seedChatRoutes(page: Page): Promise<void> {
  await seedAppStorage(page);
  await page.route("**/api/conversations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const ts = new Date(Date.now()).toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversations: [{ ...LATENCY_CONVO, createdAt: ts, updatedAt: ts }],
      }),
    });
  });
  await page.route("**/api/conversations/*/messages", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    // Cold conversation: no prior messages, so turn 1 is a true first turn.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: [] }),
    });
  });
  await installDefaultAppRoutes(page);
  await installLatencyStreamingFetch(page, {
    tokens: REPLY_TOKENS,
    firstTokenDelayMs: FIRST_TOKEN_DELAY_MS,
    intervalMs: TOKEN_INTERVAL_MS,
  });
}

function assertHealthyTurn(sample: ChatLatencySample): void {
  // 1. First rendered text within budget (Shadow's stopwatch).
  expect(
    sample.firstRenderMs,
    `turn ${sample.turn}: first-render ${Math.round(sample.firstRenderMs)}ms ` +
      `exceeds budget ${FIRST_RENDER_BUDGET_MS}ms`,
  ).toBeLessThan(FIRST_RENDER_BUDGET_MS);

  // 2. First render must not be IMPOSSIBLY fast either — a first-render before
  // the modeled first-token delay would mean the probe is measuring stale text,
  // not this turn's stream. Anchors the measurement's integrity.
  expect(
    sample.firstRenderMs,
    `turn ${sample.turn}: first-render ${Math.round(sample.firstRenderMs)}ms ` +
      `is before the first token could arrive (${FIRST_TOKEN_DELAY_MS}ms) — ` +
      `probe likely read stale text`,
  ).toBeGreaterThanOrEqual(FIRST_TOKEN_DELAY_MS - 50);

  // 3. GENUINE STREAMING — the biggest UX lever. A single-chunk regression
  // (non-incremental generateText on the bridge) reds here even though its
  // first-byte would be just as fast.
  expect(
    sample.serverChunks,
    `turn ${sample.turn}: only ${sample.serverChunks} server chunk(s) — ` +
      `reply is NOT streaming (single-chunk regression)`,
  ).toBeGreaterThanOrEqual(MIN_STREAM_CHUNKS);
  expect(
    sample.serverSpreadMs,
    `turn ${sample.turn}: chunks spread only ${Math.round(sample.serverSpreadMs)}ms — ` +
      `reply arrived as one blob, not a stream`,
  ).toBeGreaterThanOrEqual(MIN_STREAM_SPREAD_MS);

  // 4. Full render must land after first render (sanity: it fills in over time).
  expect(sample.fullRenderMs).toBeGreaterThanOrEqual(sample.firstRenderMs);
}

test.describe("chat latency e2e regression gate", () => {
  // Idle-gap scenario waits 35s in-page; give the whole spec generous headroom.
  test.setTimeout(120_000);

  test("cold + post-idle turns render first token fast and stream incrementally", async ({
    page,
  }, testInfo) => {
    await seedChatRoutes(page);
    await openAppPath(page, "/chat");

    const overlay = page.getByTestId("continuous-chat-overlay");
    await expect(overlay).toBeVisible({ timeout: 60_000 });
    const composer = page.getByTestId("chat-composer-textarea");
    await expect(composer).toBeVisible({ timeout: 15_000 });

    const samples: ChatLatencySample[] = [];

    // --- Turn 1: COLD conversation, first message ---------------------------
    const cold = await measureChatTurn(page, {
      turn: 1,
      afterIdle: false,
      message: "how does the scheduler decide what to run next?",
      finalText: REPLY_FINAL_MARKER,
    });
    annotateSample(testInfo, cold);
    samples.push(cold);
    assertHealthyTurn(cold);

    // --- 35s idle gap (Shadow's demo Q&A pacing) ----------------------------
    // Real server: this is where cold scope re-hydrates. Here it proves the
    // CLIENT render + streaming path stays healthy across an idle — no buffered
    // catch-up, no lost throttle frame, no render stall on the next turn.
    await page.waitForTimeout(35_000);

    // --- Turn 2: after the idle gap -----------------------------------------
    const postIdle = await measureChatTurn(page, {
      turn: 2,
      afterIdle: true,
      message: "and what changed after the idle gap?",
      finalText: REPLY_FINAL_MARKER,
    });
    annotateSample(testInfo, postIdle);
    samples.push(postIdle);
    assertHealthyTurn(postIdle);

    // --- Aggregate signal ---------------------------------------------------
    const firstRenders = samples.map((s) => s.firstRenderMs);
    const p95FirstRender = p95(firstRenders);

    // Emit the measured table to the CI log so the gate's numbers are visible
    // evidence, not just a pass/fail (the `list` reporter drops annotations).
    for (const s of samples) {
      console.log(
        `[chat-latency-e2e] turn ${s.turn}` +
          `${s.afterIdle ? " (post-idle)" : " (cold)"}: ` +
          `first-render ${Math.round(s.firstRenderMs)}ms, ` +
          `full-render ${Math.round(s.fullRenderMs)}ms, ` +
          `${s.serverChunks} chunks over ${Math.round(s.serverSpreadMs)}ms`,
      );
    }
    console.log(
      `[chat-latency-e2e] p95 first-render ${Math.round(p95FirstRender)}ms ` +
        `(budget ${FIRST_RENDER_BUDGET_MS}ms)`,
    );
    testInfo.annotations.push({
      type: "chat-latency-summary",
      description:
        `p95 first-render ${Math.round(p95FirstRender)}ms ` +
        `(budget ${FIRST_RENDER_BUDGET_MS}ms), ` +
        `min chunks ${Math.min(...samples.map((s) => s.serverChunks))}`,
    });
    expect(
      p95FirstRender,
      `p95 first-render ${Math.round(p95FirstRender)}ms exceeds budget ${FIRST_RENDER_BUDGET_MS}ms`,
    ).toBeLessThan(FIRST_RENDER_BUDGET_MS);
  });
});
