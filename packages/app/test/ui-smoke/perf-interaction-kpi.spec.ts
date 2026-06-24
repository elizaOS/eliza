// Interaction-framerate KPI for the dashboard shell (#9141).
//
// `perf-load-kpi.spec.ts` proves the app *loads* within a web-vitals budget;
// this proves the shell *stays smooth* during the hot interactions the issue
// targets — long-thread scroll, the sheet open/close spring (the flex-basis
// height morph, task 5), and a real pointer drag of the sheet. An in-page rAF
// sampler records inter-frame deltas during each interaction and summarizes them
// with the same math as the live HUD (`summarizeFrameSamples`), so the numbers
// are the 60/120fps signal the issue asked to stop flying blind on.
//
// Budgets are SOFT and generous (headless Chromium caps rAF at ~60fps and CI is
// noisy) so the spec is a measurement + coarse jank regression guard, not a
// brittle gate — the same philosophy as perf-load-kpi. The reported fps / p95 /
// worst-frame / dropped-frame numbers are the meaningful signal; record a video
// with E2E_RECORD=1.

import { expect, test } from "@playwright/test";
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
// = 80). The test seeds this conversation as active so the transcript is always
// populated before the interaction KPI starts.
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
const EXPECTED_RENDERED_THREAD_LINES = 80;

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

test.describe("dashboard shell interaction framerate", () => {
  test.beforeEach(async ({ page }) => {
    await seedAppStorage(page, {
      "eliza:chat:activeConversationId": PERF_CONVO.id,
    });
    await installDefaultAppRoutes(page);
    const messages = [...LONG_THREAD];
    let streamSequence = 0;
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
    await page.route(
      `**/api/conversations/${PERF_CONVO.id}/messages`,
      async (route) => {
        if (route.request().method() !== "GET") {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ messages }),
        });
      },
    );
    await page.route(
      `**/api/conversations/${PERF_CONVO.id}/messages/stream`,
      async (route) => {
        if (route.request().method() !== "POST") {
          await route.fallback();
          return;
        }
        const body = JSON.parse(route.request().postData() ?? "{}") as {
          text?: string;
        };
        const userText = (body.text ?? "").trim() || "perf probe";
        streamSequence += 1;
        const assistantText = "Perf probe acknowledged.";
        messages.push({
          id: `perf-user-${streamSequence}`,
          role: "user",
          text: userText,
          timestamp: Date.now(),
        });
        messages.push({
          id: `perf-assistant-${streamSequence}`,
          role: "assistant",
          text: assistantText,
          timestamp: Date.now(),
        });
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body:
            `data: ${JSON.stringify({
              type: "token",
              text: assistantText,
              fullText: assistantText,
            })}\n\n` +
            `data: ${JSON.stringify({
              type: "done",
              fullText: assistantText,
              agentName: "Eliza",
            })}\n\n`,
        });
      },
    );
    await page.route(
      new RegExp(`/api/conversations/${PERF_CONVO.id}/greeting(?:\\?|$)`),
      async (route) => {
        if (route.request().method() !== "GET") {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ text: "", localInference: null }),
        });
      },
    );
    // Must be installed before navigation so the rAF sampler survives bootstrap.
    await installFrameSampler(page);
  });

  test("scroll, sheet open/close, and drag hold a smooth frame budget", async ({
    page,
  }, testInfo) => {
    await openAppPath(page, "/chat");
    const overlay = page.getByTestId("continuous-chat-overlay");
    await expect(overlay).toBeVisible({ timeout: 60_000 });

    // Open the sheet (springs the transcript into view) by sending a line.
    const composer = page.getByTestId("chat-composer-textarea");
    await composer.fill("perf probe");
    await page.getByTestId("chat-composer-action").click();
    await expect(overlay).toHaveAttribute("data-open", "true", {
      timeout: 15_000,
    });

    const thread = page.getByTestId("chat-thread");
    await expect(thread).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => page.getByTestId("thread-line").count(), {
        message: "long transcript should populate before measuring scroll",
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(EXPECTED_RENDERED_THREAD_LINES);
    const renderedLines = await page.getByTestId("thread-line").count();
    testInfo.annotations.push({
      type: "frame-kpi",
      description: `transcript rendered ${renderedLines} thread-line nodes (cap ${EXPECTED_RENDERED_THREAD_LINES})`,
    });
    await expect
      .poll(
        async () =>
          page
            .getByTestId("thread-line")
            .last()
            .evaluate((el) => {
              const style = window.getComputedStyle(el);
              return `${Number(style.opacity).toFixed(3)}|${style.transform}`;
            })
            .catch(() => ""),
        {
          message:
            "latest message entrance animation should settle before scroll KPI",
          timeout: 3_000,
        },
      )
      .toBe("1.000|none");

    // --- Scenario A: long-thread scroll ---------------------------------------
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

    // --- Scenario B: sheet open/close spring (flex-basis height morph) --------
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

    // --- Scenario C: pointer drag of the sheet grabber ------------------------
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
