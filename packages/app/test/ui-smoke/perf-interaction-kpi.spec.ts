// Interaction-framerate KPI for the dashboard shell (#9141).
//
// `perf-load-kpi.spec.ts` proves the app *loads* within a web-vitals budget;
// this proves the shell *stays smooth* during the hot interactions the issue
// targets — live token streaming, long-thread scroll, the sheet open/close
// spring (the flex-basis height morph, task 5), a real pointer drag of the
// sheet, and an in-app /chat -> /settings view transition. An in-page rAF sampler
// records inter-frame deltas during each interaction and summarizes them with
// the same math as the live HUD (`summarizeFrameSamples`), so the numbers are the
// 60/120fps signal the issue asked to stop flying blind on.
//
// Budgets are SOFT and generous (headless Chromium caps rAF at ~60fps and CI is
// noisy) so the spec is a measurement + coarse jank regression guard, not a
// brittle gate — the same philosophy as perf-load-kpi. The reported fps / p95 /
// worst-frame / dropped-frame numbers are the meaningful signal; record a video
// with E2E_RECORD=1.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  FRAME_BUDGET_60_MS,
  type FrameKpiSummary,
  formatFrameSummary,
  installFrameSampler,
  measureFrames,
} from "./lib/frame-kpi";

// A long thread so scroll hits the transcript windowing (MAX_RENDERED_SHELL_MESSAGES
// = 80). The wildcard messages route returns this for whatever conversation the
// shell makes active, so the transcript is always populated.
const LONG_THREAD = Array.from({ length: 120 }, (_, i) => {
  const role = i % 2 === 0 ? "user" : "assistant";
  return {
    id: `perf-${i}`,
    role,
    text:
      role === "user"
        ? `Question ${i}: how does the scheduler decide what to run next?`
        : `Answer ${i}: it pattern-matches structural fields on each ScheduledTask record and routes through the single runner. Line ${i} of a long reply to give the transcript real height.`,
    timestamp: Date.now() - (120 - i) * 1000,
  };
});

const PERF_CONVO = {
  id: "perf-thread",
  title: "Perf probe thread",
  roomId: "room-perf",
};

const STREAMING_REPLY_TOKENS = [
  "Streaming ",
  "frame ",
  "budget ",
  "probe ",
  "renders ",
  "token ",
  "chunks ",
  "one ",
  "at ",
  "a ",
  "time ",
  "while ",
  "the ",
  "dashboard ",
  "keeps ",
  "the ",
  "shell ",
  "responsive. ",
  "The ",
  "final ",
  "marker ",
  "is ",
  "Streaming ",
  "frame ",
  "budget ",
  "probe ",
  "complete.",
] as const;
const STREAMING_REPLY_TEXT = STREAMING_REPLY_TOKENS.join("");

// A frame KPI is "ok" when it captured frames and p95 stayed under a coarse jank
// ceiling (3 × the 60fps budget ≈ 50ms). Tolerant of headless/CI noise while
// still catching a genuinely janky interaction (a 100ms+ p95 layout stall).
const P95_JANK_CEILING_MS = FRAME_BUDGET_60_MS * 3;

function assertFrameKpi(
  testInfo: ReturnType<typeof test.info>,
  label: string,
  summary: FrameKpiSummary,
): void {
  const line = formatFrameSummary(label, summary);
  testInfo.annotations.push({ type: "frame-kpi", description: line });
  // Intentional KPI output for the e2e reporter (console permitted in tests).
  console.log(`[perf-interaction-kpi] ${line}`);
  expect(
    summary.sampleCount,
    `${label}: expected to sample frames during the interaction`,
  ).toBeGreaterThan(0);
  expect(
    summary.p95FrameMs,
    `${label}: p95 ${summary.p95FrameMs.toFixed(1)}ms exceeds jank ceiling ${P95_JANK_CEILING_MS.toFixed(1)}ms`,
  ).toBeLessThan(P95_JANK_CEILING_MS);
}

/**
 * Playwright route.fulfill buffers bodies, which would turn an SSE stream into
 * one synchronous blob and defeat the #9141 "live token streaming" KPI. Patch
 * fetch in the browser instead so the production client consumes a real
 * ReadableStream with token chunks arriving over time.
 */
async function installStreamingFetch(page: Page): Promise<void> {
  await page.addInitScript(
    ({ tokens, finalText }) => {
      const originalFetch = window.fetch.bind(window);
      let sequence = 0;
      (
        window as unknown as {
          __ELIZA_PERF_STREAMS__?: Array<{
            sequence: number;
            tokenCount: number;
            durationMs: number;
          }>;
        }
      ).__ELIZA_PERF_STREAMS__ = [];

      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : String(input);
        const url = new URL(rawUrl, window.location.href);
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();

        if (
          method === "POST" &&
          /^\/api\/conversations\/[^/]+\/messages\/stream$/.test(url.pathname)
        ) {
          sequence += 1;
          const streamSequence = sequence;
          const startedAt = performance.now();
          const encoder = new TextEncoder();
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              let fullText = "";
              const emitToken = (index: number) => {
                if (index < tokens.length) {
                  const token = tokens[index] ?? "";
                  fullText += token;
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        type: "token",
                        text: token,
                        fullText,
                      })}\n\n`,
                    ),
                  );
                  window.setTimeout(() => emitToken(index + 1), 24);
                  return;
                }
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      type: "done",
                      fullText: finalText,
                      agentName: "Eliza",
                    })}\n\n`,
                  ),
                );
                controller.close();
                (
                  window as unknown as {
                    __ELIZA_PERF_STREAMS__?: Array<{
                      sequence: number;
                      tokenCount: number;
                      durationMs: number;
                    }>;
                  }
                ).__ELIZA_PERF_STREAMS__?.push({
                  sequence: streamSequence,
                  tokenCount: tokens.length,
                  durationMs: performance.now() - startedAt,
                });
              };
              window.setTimeout(() => emitToken(0), 24);
            },
          });

          return new Response(stream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
            },
          });
        }

        return originalFetch(input, init);
      };
    },
    {
      tokens: [...STREAMING_REPLY_TOKENS],
      finalText: STREAMING_REPLY_TEXT,
    },
  );
}

test.describe("dashboard shell interaction framerate", () => {
  test.beforeEach(async ({ page }) => {
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
          conversations: [{ ...PERF_CONVO, createdAt: ts, updatedAt: ts }],
        }),
      });
    });
    await page.route("**/api/conversations/*/messages", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: LONG_THREAD }),
      });
    });
    await installDefaultAppRoutes(page);
    // Must be installed before navigation so the rAF sampler survives bootstrap.
    await installFrameSampler(page);
    // Must be installed before navigation so the app's stream fetch is patched.
    await installStreamingFetch(page);
  });

  test("scroll, sheet open/close, and drag hold a smooth frame budget", async ({
    page,
  }, testInfo) => {
    await openAppPath(page, "/chat");
    const overlay = page.getByTestId("continuous-chat-overlay");
    await expect(overlay).toBeVisible({ timeout: 60_000 });

    // --- Scenario A: live token streaming ------------------------------------
    // Sending opens the sheet and streams a real incremental ReadableStream
    // through the production SSE parser + React streaming path.
    const composer = page.getByTestId("chat-composer-textarea");
    const streamSummary = await measureFrames(page, async () => {
      await composer.fill("perf streaming probe");
      await page.getByTestId("chat-composer-action").click();
      await expect(
        page.getByText(/Streaming frame budget probe complete/).last(),
      ).toBeVisible({ timeout: 20_000 });
    });
    assertFrameKpi(testInfo, "live-token-stream", streamSummary);
    const streamInfo = await page.evaluate(
      () =>
        (
          window as unknown as {
            __ELIZA_PERF_STREAMS__?: Array<{
              tokenCount: number;
              durationMs: number;
            }>;
          }
        ).__ELIZA_PERF_STREAMS__?.at(-1) ?? null,
    );
    expect(
      streamInfo,
      "streaming fixture must run through the fetch stream",
    ).toMatchObject({
      tokenCount: STREAMING_REPLY_TOKENS.length,
    });
    testInfo.annotations.push({
      type: "frame-kpi",
      description: `live-token-stream fixture: ${streamInfo?.tokenCount ?? 0} tokens over ${Math.round(streamInfo?.durationMs ?? 0)}ms`,
    });
    await expect(overlay).toHaveAttribute("data-open", "true", {
      timeout: 15_000,
    });

    const thread = page.getByTestId("chat-thread");
    await expect(thread).toBeVisible({ timeout: 15_000 });
    const renderedLines = await page.getByTestId("thread-line").count();
    testInfo.annotations.push({
      type: "frame-kpi",
      description: `transcript rendered ${renderedLines} thread-line nodes (cap 80)`,
    });

    // --- Scenario B: long-thread scroll ---------------------------------------
    const box = await thread.boundingBox();
    const cx = box ? box.x + box.width / 2 : 200;
    const cy = box ? box.y + box.height / 2 : 300;
    const scrollSummary = await measureFrames(page, async () => {
      await page.mouse.move(cx, cy);
      // Up then down through the transcript, paced ~1 frame between wheels so the
      // browser actually renders scroll frames we can measure.
      for (let i = 0; i < 24; i++) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(12);
      }
      for (let i = 0; i < 24; i++) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(12);
      }
    });
    assertFrameKpi(testInfo, "transcript-scroll", scrollSummary);

    // --- Scenario C: sheet open/close spring (flex-basis height morph) --------
    const openCloseSummary = await measureFrames(page, async () => {
      for (let i = 0; i < 3; i++) {
        await composer.press("Escape"); // collapse
        await page.waitForTimeout(260);
        await composer.fill(`reopen ${i}`); // typing springs it open again
        await page.waitForTimeout(260);
      }
    });
    assertFrameKpi(testInfo, "sheet-open-close", openCloseSummary);
    // Make sure we end open for the drag scenario.
    await composer.fill("hold open");
    await expect(overlay).toHaveAttribute("data-open", "true", {
      timeout: 10_000,
    });

    // --- Scenario D: pointer drag of the sheet grabber ------------------------
    const grabber = page.getByTestId("chat-sheet-grabber");
    if (await grabber.isVisible().catch(() => false)) {
      const gb = await grabber.boundingBox();
      if (gb) {
        const gx = gb.x + gb.width / 2;
        const gy = gb.y + gb.height / 2;
        const dragSummary = await measureFrames(page, async () => {
          await page.mouse.move(gx, gy);
          await page.mouse.down();
          // Drag up then down in small steps — exercises the per-frame sheet-height
          // (flex-basis) transform the issue flags in task 5.
          for (let i = 0; i < 20; i++) {
            await page.mouse.move(gx, gy - i * 6, { steps: 1 });
            await page.waitForTimeout(12);
          }
          for (let i = 20; i >= 0; i--) {
            await page.mouse.move(gx, gy - i * 6, { steps: 1 });
            await page.waitForTimeout(12);
          }
          await page.mouse.up();
        });
        assertFrameKpi(testInfo, "sheet-drag", dragSummary);
      }
    } else {
      testInfo.annotations.push({
        type: "frame-kpi",
        description: "sheet-drag: grabber not visible, scenario skipped",
      });
    }

    // --- Scenario E: /chat -> another-view transition -------------------------
    const viewTransitionSummary = await measureFrames(page, async () => {
      await page.evaluate(() => {
        window.history.pushState(null, "", "/settings");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(page.getByTestId("settings-shell")).toBeVisible({
        timeout: 20_000,
      });
    });
    assertFrameKpi(testInfo, "chat-to-settings", viewTransitionSummary);

    // --- Evidence: the dev PerfOverlay HUD renders live numbers ---------------
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__ELIZA_PERF_HUD__ = true;
      window.dispatchEvent(new Event("eliza:perf-toggle"));
    });
    const hud = page.getByTestId("perf-overlay");
    await expect(hud).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(700); // let the 500ms HUD poll publish a summary
    await expect(hud).toContainText(/fps/);
    await page.screenshot({
      path: testInfo.outputPath("perf-overlay-hud.png"),
    });
    testInfo.annotations.push({
      type: "frame-kpi",
      description: `PerfOverlay HUD live readout: ${(await hud.innerText()).replace(/\s+/g, " ").trim()}`,
    });
  });
});
