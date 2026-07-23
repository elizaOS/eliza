/**
 * Proves chat streaming across the real local runtime and production browser
 * surface. The model is deterministic, but every layer around it is real:
 * model callback, message loop, persisted conversation, HTTP SSE, client
 * parser, React state, transcript DOM, layout, and browser frame scheduling.
 */

import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { openAppPath, seedAppStorage } from "./helpers";

const REAL_LOCAL_STACK = process.env.ELIZA_UI_SMOKE_REAL_LOCAL_STACK === "1";
const RESPONSE_MARKER = "STREAM_E2E_OK";
const STREAM_PATH = /\/api\/conversations\/[^/]+\/messages\/stream$/;

type StreamFrame = {
  atMs: number;
  fullText?: string;
  text?: string;
  type?: string;
};

type StreamRecord = {
  doneAtMs: number | null;
  firstByteAtMs: number | null;
  frames: StreamFrame[];
  requestAtMs: number;
  wireChunkCount: number;
};

type PaintRecord = {
  atMs: number;
  text: string;
};

type RealStreamProbe = {
  frameTimes: number[];
  layoutShifts: Array<{
    atMs: number;
    outsideChat: boolean;
    value: number;
  }>;
  layoutShiftObserverSupported: boolean;
  streams: StreamRecord[];
};

type RenderProbe = {
  activeNode: Element | null;
  activeNodeDisconnected: boolean;
  activeNodeReplacements: number;
  composerTopBefore: number;
  frameHandle: number;
  historicalMutations: number;
  historicalNode: Element;
  historicalNodeDisconnected: boolean;
  identityRunning: boolean;
  paints: PaintRecord[];
  running: boolean;
};

async function installRealStreamInstrumentation(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.addInitScript(
    ({ streamPattern }) => {
      const state = window as unknown as {
        __ELIZA_REAL_STREAM_PROBE__?: RealStreamProbe;
      };
      const probe: RealStreamProbe = {
        frameTimes: [],
        layoutShifts: [],
        layoutShiftObserverSupported: false,
        streams: [],
      };
      state.__ELIZA_REAL_STREAM_PROBE__ = probe;

      const sampleFrame = (now: number) => {
        probe.frameTimes.push(now);
        requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);

      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & {
            hadRecentInput?: boolean;
            sources?: Array<{ node?: Node | null }>;
            value?: number;
          };
          if (shift.hadRecentInput || !(Number(shift.value) > 0)) continue;
          const sources = Array.isArray(shift.sources) ? shift.sources : [];
          const outsideChat = sources.some((source) => {
            const node = source.node;
            const element =
              node instanceof Element ? node : node?.parentElement;
            return element
              ? !element.closest(
                  '[data-testid="chat-overlay"], [data-testid="chat-sheet"]',
                )
              : false;
          });
          probe.layoutShifts.push({
            atMs: performance.now(),
            outsideChat,
            value: Number(shift.value),
          });
        }
      });
      if (PerformanceObserver.supportedEntryTypes.includes("layout-shift")) {
        observer.observe({ type: "layout-shift", buffered: true });
        probe.layoutShiftObserverSupported = true;
      }

      const nativeFetch = window.fetch.bind(window);
      const pathPattern = new RegExp(streamPattern);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        if (
          request.method.toUpperCase() !== "POST" ||
          !pathPattern.test(new URL(request.url).pathname)
        ) {
          return nativeFetch(input, init);
        }

        const record: StreamRecord = {
          doneAtMs: null,
          firstByteAtMs: null,
          frames: [],
          requestAtMs: performance.now(),
          wireChunkCount: 0,
        };
        probe.streams.push(record);
        const response = await nativeFetch(input, init);
        if (!response.body) return response;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let reconstructedText = "";
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const result = await reader.read();
            if (result.done) {
              buffer += decoder.decode();
              controller.close();
              return;
            }
            const now = performance.now();
            record.firstByteAtMs ??= now;
            record.wireChunkCount += 1;
            buffer += decoder.decode(result.value, { stream: true });
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) {
              const event = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = event
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n");
              if (data) {
                try {
                  const parsed = JSON.parse(data) as {
                    fullText?: string;
                    text?: string;
                    type?: string;
                  };
                  if (parsed.type === "token") {
                    reconstructedText =
                      typeof parsed.fullText === "string"
                        ? parsed.fullText
                        : reconstructedText + (parsed.text ?? "");
                  }
                  const frame = { ...parsed, atMs: now };
                  if (parsed.type === "token") {
                    frame.fullText = reconstructedText;
                  }
                  record.frames.push(frame);
                  if (parsed.type === "done") record.doneAtMs = now;
                } catch {
                  // error-policy:J3 instrumentation ignores invalid SSE JSON
                  // while the production parser owns the user-visible failure.
                }
              }
              boundary = buffer.indexOf("\n\n");
            }
            controller.enqueue(result.value);
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        });

        return new Response(body, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      };
    },
    { streamPattern: STREAM_PATH.source },
  );
}

async function sendAndWaitForDone(
  page: import("@playwright/test").Page,
  text: string,
  expectedStreamCount: number,
): Promise<void> {
  const composer = page.getByTestId("chat-composer-textarea");
  await composer.fill(text);
  await page.getByTestId("chat-composer-action").click();
  await page.waitForFunction(
    (count) => {
      const probe = (
        window as unknown as {
          __ELIZA_REAL_STREAM_PROBE__?: RealStreamProbe;
        }
      ).__ELIZA_REAL_STREAM_PROBE__;
      return (
        probe?.streams.length === count &&
        probe.streams[count - 1]?.doneAtMs !== null
      );
    },
    expectedStreamCount,
    { timeout: 60_000 },
  );
}

test.describe("real-runtime chat stream performance", () => {
  test.skip(!REAL_LOCAL_STACK, "requires ELIZA_UI_SMOKE_REAL_LOCAL_STACK=1");
  test.setTimeout(180_000);

  test("streams once without sibling rerenders, remounts, reflow, or visible jank", async ({
    page,
  }, testInfo) => {
    await installRealStreamInstrumentation(page);
    const conversationResponse = await page.request.post("/api/conversations", {
      data: {
        title: "Real stream performance",
        metadata: { scope: "general" },
      },
    });
    expect(conversationResponse.ok()).toBe(true);
    const conversationBody = (await conversationResponse.json()) as {
      conversation?: { id?: string };
    };
    const conversationId = conversationBody.conversation?.id;
    expect(conversationId).toBeTruthy();

    await seedAppStorage(page, {
      "eliza:chat:activeConversationId": conversationId ?? "",
    });
    await openAppPath(page, "/chat");
    await expect(page.getByTestId("chat-composer-textarea")).toBeVisible();

    const firstHistoryReload = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          `/api/conversations/${conversationId}/messages` &&
        response.ok(),
    );
    await sendAndWaitForDone(page, "Establish the completed history row.", 1);
    const firstReloadResponse = await firstHistoryReload;
    await firstReloadResponse.finished();
    await page.waitForTimeout(500);
    await expect(
      page
        .locator('[data-testid="thread-line"][data-role="assistant"]')
        .filter({ hasText: RESPONSE_MARKER }),
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: "talk" })).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    await page.evaluate(() => {
      const state = window as unknown as {
        __ELIZA_REAL_STREAM_PROBE__?: RealStreamProbe;
        __ELIZA_REAL_STREAM_RENDER__?: RenderProbe;
      };
      const historicalNode = Array.from(
        document.querySelectorAll(
          '[data-testid="thread-line"][data-role="assistant"]',
        ),
      ).at(-1);
      const composer = document.querySelector(
        '[data-testid="chat-composer-textarea"]',
      );
      if (!historicalNode || !composer) {
        throw new Error("chat render probe could not find baseline nodes");
      }
      const renderProbe: RenderProbe = {
        activeNode: null,
        activeNodeDisconnected: false,
        activeNodeReplacements: 0,
        composerTopBefore: composer.getBoundingClientRect().top,
        frameHandle: 0,
        historicalMutations: 0,
        historicalNode,
        historicalNodeDisconnected: false,
        identityRunning: true,
        paints: [],
        running: true,
      };
      state.__ELIZA_REAL_STREAM_RENDER__ = renderProbe;
      state.__ELIZA_REAL_STREAM_PROBE__.frameTimes = [];
      state.__ELIZA_REAL_STREAM_PROBE__.layoutShifts = [];

      const historyObserver = new MutationObserver((records) => {
        renderProbe.historicalMutations += records.length;
      });
      historyObserver.observe(historicalNode, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });

      const sample = (now: number) => {
        if (!renderProbe.running) {
          historyObserver.disconnect();
          return;
        }
        const measuredStream = state.__ELIZA_REAL_STREAM_PROBE__?.streams[1];
        if (
          renderProbe.identityRunning &&
          measuredStream &&
          measuredStream.doneAtMs !== null
        ) {
          renderProbe.identityRunning = false;
          historyObserver.disconnect();
        }
        const assistantRows = Array.from(
          document.querySelectorAll(
            '[data-testid="thread-line"][data-role="assistant"]',
          ),
        );
        const candidate = assistantRows.at(-1) ?? null;
        if (candidate && candidate !== renderProbe.historicalNode) {
          if (renderProbe.identityRunning) {
            if (!renderProbe.historicalNode.isConnected) {
              renderProbe.historicalNodeDisconnected = true;
            }
            if (renderProbe.activeNode && !renderProbe.activeNode.isConnected) {
              renderProbe.activeNodeDisconnected = true;
            }
            if (
              renderProbe.activeNode &&
              candidate !== renderProbe.activeNode
            ) {
              renderProbe.activeNodeReplacements += 1;
              renderProbe.activeNode = candidate;
            }
            renderProbe.activeNode ??= candidate;
          }
          const text = (candidate as HTMLElement).innerText;
          if (renderProbe.paints.at(-1)?.text !== text) {
            renderProbe.paints.push({ atMs: now, text });
          }
        }
        renderProbe.frameHandle = requestAnimationFrame(sample);
      };
      renderProbe.frameHandle = requestAnimationFrame(sample);
    });

    const secondHistoryReload = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname ===
          `/api/conversations/${conversationId}/messages` &&
        response.ok(),
    );
    await sendAndWaitForDone(page, "Measure the real streaming surface.", 2);
    const secondReloadResponse = await secondHistoryReload;
    await secondReloadResponse.finished();
    const streamedRows = page
      .locator('[data-testid="thread-line"][data-role="assistant"]')
      .filter({ hasText: RESPONSE_MARKER });
    await expect(streamedRows).toHaveCount(2);
    await expect(
      page
        .locator('[data-testid="thread-line"][data-role="assistant"]')
        .filter({ hasText: "I'm not sure how to answer that." }),
    ).toHaveCount(0);
    await page.waitForTimeout(150);

    const metrics = await page.evaluate((responseMarker) => {
      const state = window as unknown as {
        __ELIZA_REAL_STREAM_PROBE__?: RealStreamProbe;
        __ELIZA_REAL_STREAM_RENDER__?: RenderProbe;
      };
      const probe = state.__ELIZA_REAL_STREAM_PROBE__;
      const renderProbe = state.__ELIZA_REAL_STREAM_RENDER__;
      if (!probe || !renderProbe) {
        throw new Error("real stream browser probe is unavailable");
      }
      renderProbe.running = false;
      cancelAnimationFrame(renderProbe.frameHandle);
      const stream = probe.streams[1];
      const rawTokenFrames = stream.frames.filter(
        (frame) => frame.type === "token" && frame.fullText,
      );
      const tokenFrames = rawTokenFrames.filter(
        (frame, index) =>
          index === 0 || frame.fullText !== rawTokenFrames[index - 1]?.fullText,
      );
      const doneAtMs = stream.doneAtMs ?? performance.now();
      const tokenPaintLatencies = tokenFrames
        .map((frame) => {
          const paint = renderProbe.paints.find(
            (candidate) =>
              candidate.atMs >= frame.atMs &&
              candidate.text.includes(frame.fullText ?? ""),
          );
          return paint ? paint.atMs - frame.atMs : null;
        })
        .filter((value): value is number => value !== null);
      const firstTokenAtMs = tokenFrames[0]?.atMs ?? doneAtMs;
      const frameTimes = probe.frameTimes.filter(
        (time) => time >= firstTokenAtMs && time <= doneAtMs + 100,
      );
      const frameDeltas = frameTimes
        .slice(1)
        .map((time, index) => time - (frameTimes[index] ?? time));
      const measuredLayoutShifts = probe.layoutShifts.filter(
        (shift) => shift.atMs >= firstTokenAtMs && shift.atMs <= doneAtMs,
      );
      const percentile = (values: number[], quantile: number) => {
        if (values.length === 0) return 0;
        const sorted = values.toSorted((a, b) => a - b);
        return (
          sorted[
            Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)
          ] ?? 0
        );
      };
      const composer = document.querySelector(
        '[data-testid="chat-composer-textarea"]',
      );
      return {
        activeNodeObserved: renderProbe.activeNode !== null,
        activeNodeStableDuringStream: !renderProbe.activeNodeDisconnected,
        activeNodeReplacements: renderProbe.activeNodeReplacements,
        cls: measuredLayoutShifts.reduce((sum, shift) => sum + shift.value, 0),
        composerMovementPx: composer
          ? Math.abs(
              composer.getBoundingClientRect().top -
                renderProbe.composerTopBefore,
            )
          : Number.POSITIVE_INFINITY,
        doneLeadMs:
          doneAtMs -
          (renderProbe.paints.find((paint) =>
            paint.text.includes(responseMarker),
          )?.atMs ?? doneAtMs),
        droppedFrameRatio:
          frameDeltas.filter((delta) => delta > 25).length /
          Math.max(1, frameDeltas.length),
        firstTokenToPaintMs: tokenPaintLatencies[0] ?? Number.POSITIVE_INFINITY,
        frameP95Ms: percentile(frameDeltas, 0.95),
        historicalMutations: renderProbe.historicalMutations,
        historicalNodeStableDuringStream:
          !renderProbe.historicalNodeDisconnected,
        layoutShiftObserverSupported: probe.layoutShiftObserverSupported,
        outsideChatLayoutShifts: measuredLayoutShifts.filter(
          (shift) => shift.outsideChat,
        ).length,
        paintCommits: renderProbe.paints.filter(
          (paint) => paint.atMs >= firstTokenAtMs && paint.atMs <= doneAtMs,
        ).length,
        tokenFrames: tokenFrames.length,
        tokenPaintCoverage:
          tokenPaintLatencies.length / Math.max(1, tokenFrames.length),
        tokenToPaintP50Ms: percentile(tokenPaintLatencies, 0.5),
        tokenToPaintP95Ms: percentile(tokenPaintLatencies, 0.95),
        transportSpreadMs:
          (tokenFrames.at(-1)?.atMs ?? firstTokenAtMs) - firstTokenAtMs,
        wireChunkCount: stream.wireChunkCount,
      };
    }, RESPONSE_MARKER);

    const persistedResponse = await page.request.get(
      `/api/conversations/${conversationId}/messages`,
    );
    expect(persistedResponse.ok()).toBe(true);
    const persisted = (await persistedResponse.json()) as {
      messages?: Array<{ role?: string; text?: string }>;
    };
    const assistantMessages = (persisted.messages ?? []).filter(
      (message) => message.role === "assistant",
    );
    const persistedMarkerMessages = assistantMessages.filter((message) =>
      message.text?.includes(RESPONSE_MARKER),
    );

    const metricsPath = testInfo.outputPath("real-stream-performance.json");
    await writeFile(
      metricsPath,
      `${JSON.stringify(
        {
          ...metrics,
          persistedAssistantMessages: assistantMessages.length,
          persistedMarkerMessages: persistedMarkerMessages.length,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await testInfo.attach("real-stream-performance.json", {
      path: metricsPath,
      contentType: "application/json",
    });
    const screenshotPath = testInfo.outputPath("real-stream-final.jpg");
    await page.screenshot({
      fullPage: true,
      path: screenshotPath,
      quality: 90,
      type: "jpeg",
    });
    await testInfo.attach("real-stream-final.jpg", {
      path: screenshotPath,
      contentType: "image/jpeg",
    });

    expect(metrics.tokenFrames).toBeGreaterThanOrEqual(20);
    expect(metrics.wireChunkCount).toBeGreaterThanOrEqual(20);
    expect(metrics.transportSpreadMs).toBeGreaterThan(500);
    expect(metrics.paintCommits).toBeGreaterThanOrEqual(10);
    expect(metrics.tokenPaintCoverage).toBeGreaterThanOrEqual(0.9);
    expect(metrics.firstTokenToPaintMs).toBeLessThanOrEqual(75);
    expect(metrics.tokenToPaintP50Ms).toBeLessThanOrEqual(60);
    expect(metrics.tokenToPaintP95Ms).toBeLessThanOrEqual(150);
    expect(metrics.doneLeadMs).toBeGreaterThan(500);
    expect(metrics.frameP95Ms).toBeLessThanOrEqual(40);
    expect(metrics.droppedFrameRatio).toBeLessThanOrEqual(0.25);
    expect(metrics.historicalMutations).toBe(0);
    expect(metrics.historicalNodeStableDuringStream).toBe(true);
    expect(metrics.activeNodeReplacements).toBe(0);
    expect(metrics.activeNodeObserved).toBe(true);
    expect(metrics.activeNodeStableDuringStream).toBe(true);
    expect(metrics.layoutShiftObserverSupported).toBe(true);
    expect(metrics.outsideChatLayoutShifts).toBe(0);
    expect(metrics.composerMovementPx).toBeLessThanOrEqual(1);
    expect(persistedMarkerMessages).toHaveLength(2);
  });
});
