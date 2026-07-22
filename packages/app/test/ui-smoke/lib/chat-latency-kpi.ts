// Browser-level chat-latency collector for the ui-smoke Playwright harness.
//
// WHY THIS EXISTS (the measurement gap this closes):
// The server-side chat-latency harness (packages/scripts/cloud/chat-latency.mjs)
// measures `time_starttransfer` — first SSE BYTE — on a warm, reused
// conversation. That number is structurally blind to two things the USER feels:
//   1. Client render: the byte lands, but nothing is on screen until the SSE is
//      parsed, the token is committed to React state, and a frame paints.
//   2. Streaming shape: a single-chunk "done" frame (non-incremental
//      generateText on the bridge) delivers first-byte just as fast as a real
//      token stream, but the user stares at a spinner until the WHOLE reply
//      lands, then it pops in at once. First-byte cannot see that regression.
//
// Shadow's stopwatch = tap-send -> first visible rendered text in the browser.
// This collector measures exactly that, in a real Chromium page, through the
// production SSE parser (client-base.ts) + the streaming-commit rAF throttle
// (useChatSend.ts) + React render. It ALSO records the arrival timeline of the
// server chunks so a single-chunk (non-streaming) regression fails the gate
// instead of passing on a fast first byte.
//
// The streaming fixture (installLatencyStreamingFetch) patches window.fetch in
// the page — NOT page.route — because Playwright's route.fulfill buffers the
// body into one blob and would itself defeat the streaming signal (same reason
// perf-interaction-kpi.spec.ts patches fetch). The fixture emits tokens on a
// controllable cadence so the test can assert BOTH first-render latency and
// genuine incrementality deterministically.

import type { Page, TestInfo } from "@playwright/test";

/** One measured chat turn: send-click -> first painted assistant text. */
export interface ChatLatencySample {
  /** Turn ordinal in the scenario (1 = cold first turn). */
  turn: number;
  /** Whether this turn followed an idle gap (cold-ish scope re-hydration). */
  afterIdle: boolean;
  /**
   * ms from the send click to the first frame where the assistant bubble shows
   * a non-empty text node. THIS is Shadow's felt first-token number.
   */
  firstRenderMs: number;
  /** ms from send click to the assistant reply being fully rendered (done). */
  fullRenderMs: number;
  /** Distinct server chunks the fixture delivered for this turn (>1 = streamed). */
  serverChunks: number;
  /**
   * ms between the first and last server chunk. A single-chunk regression makes
   * this 0 (everything arrives at once); a real stream spreads it out.
   */
  serverSpreadMs: number;
}

/** Token cadence + payload for the deterministic streaming fixture. */
export interface LatencyStreamFixture {
  /** Tokens emitted one per `intervalMs`, in order. */
  tokens: string[];
  /** Delay before the FIRST token (models the server pre-header + TTFT). */
  firstTokenDelayMs: number;
  /** Delay between subsequent tokens (models incremental generation). */
  intervalMs: number;
}

/**
 * Install a window.fetch patch that answers the shared-chat SSE route with a
 * REAL ReadableStream, emitting `tokens` on a controllable cadence and exposing
 * the per-turn chunk timeline on `window.__ELIZA_LATENCY_STREAMS__`. Must be
 * installed via addInitScript BEFORE navigation so the production client
 * consumes the patched fetch.
 */
export async function installLatencyStreamingFetch(
  page: Page,
  fixture: LatencyStreamFixture,
): Promise<void> {
  await page.addInitScript((fx: LatencyStreamFixture) => {
    const w = window as unknown as {
      __ELIZA_LATENCY_STREAMS__?: Array<{
        sequence: number;
        nonce: string;
        chunkCount: number;
        firstChunkAtMs: number;
        lastChunkAtMs: number;
      }>;
      fetch: typeof fetch;
    };
    w.__ELIZA_LATENCY_STREAMS__ = [];
    const originalFetch = window.fetch.bind(window);
    let sequence = 0;

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

      const isChatStream =
        method === "POST" && /\/messages\/stream$/.test(url.pathname);

      if (!isChatStream) return originalFetch(input, init);

      sequence += 1;
      const streamSequence = sequence;
      const encoder = new TextEncoder();
      // A per-request nonce is prepended as the FIRST emitted token. Every turn's
      // reply body is identical, so without a unique leading token the probe's
      // MutationObserver would match the PRIOR turn's still-mounted bubble at
      // t≈0. The nonce makes "this turn's first token rendered" unambiguous.
      const nonce = `⟦t${streamSequence}⟧`;
      // Nonce first, then the reply tokens — the visible reply the user reads is
      // still `fx.tokens`; the nonce is a tiny leading marker.
      const emitTokens = [`${nonce} `, ...fx.tokens];
      const record = {
        sequence: streamSequence,
        nonce,
        chunkCount: 0,
        firstChunkAtMs: 0,
        lastChunkAtMs: 0,
      };
      w.__ELIZA_LATENCY_STREAMS__?.push(record);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let fullText = "";
          const emit = (index: number) => {
            if (index < emitTokens.length) {
              const token = emitTokens[index] ?? "";
              fullText += token;
              const now = performance.now();
              if (record.chunkCount === 0) record.firstChunkAtMs = now;
              record.lastChunkAtMs = now;
              record.chunkCount += 1;
              // The production client (client-base.ts) understands both the
              // legacy per-token `fullText` frame and the delta protocol; emit
              // the legacy shape so the parser commits text on EVERY chunk.
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "token",
                    text: token,
                    fullText,
                  })}\n\n`,
                ),
              );
              const delay = index === 0 ? 0 : fx.intervalMs;
              window.setTimeout(() => emit(index + 1), delay);
              return;
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: "done",
                  fullText,
                  agentName: "Eliza",
                })}\n\n`,
              ),
            );
            controller.close();
          };
          // The FIRST token is delayed by firstTokenDelayMs to model the real
          // server pre-header (auth/scope) + model TTFT the user waits through.
          window.setTimeout(() => emit(0), fx.firstTokenDelayMs);
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        },
      });
    };
  }, fixture);
}

/**
 * Drive one chat turn and measure send-click -> first painted assistant text
 * IN THE BROWSER. A MutationObserver installed just before the click records
 * `performance.now()` the instant the assistant bubble first shows non-empty
 * text, and again when the reply reaches its final text — so the number is the
 * real paint moment, not a Playwright poll interval.
 */
export async function measureChatTurn(
  page: Page,
  options: {
    turn: number;
    afterIdle: boolean;
    message: string;
    finalText: string;
  },
): Promise<ChatLatencySample> {
  const composer = page.getByTestId("chat-composer-textarea");
  await composer.fill(options.message);

  // Arm the in-page observer BEFORE the click so t0 is the click itself and the
  // first assistant-reply paint is captured with sub-frame precision.
  //
  // Turn-safe first-render detection via the per-request NONCE: the fixture
  // prepends a unique ⟦tN⟧ marker to each reply. At arm-time we snapshot the set
  // of nonces already mounted (prior turns' replies stay in the transcript), so
  // first-render is the instant an assistant bubble shows a nonce we had NOT
  // seen — unambiguously THIS turn's reply, never a stale bubble or the echoed
  // user message.
  await page.evaluate(
    ({ finalText }) => {
      const w = window as unknown as {
        __ELIZA_TURN_PROBE__?: {
          t0: number;
          firstRenderMs: number | null;
          fullRenderMs: number | null;
          observer: MutationObserver;
        };
      };
      // Tear down any prior probe.
      w.__ELIZA_TURN_PROBE__?.observer.disconnect();

      const NONCE_RE = /⟦t(\d+)⟧/;
      const assistantBubbles = (): HTMLElement[] =>
        Array.from(
          document.querySelectorAll('[data-testid="thread-line"]'),
        ).filter(
          (el) => (el as HTMLElement).getAttribute("data-role") === "assistant",
        ) as HTMLElement[];

      // Snapshot nonces present BEFORE this turn's reply arrives.
      const seenNonces = new Set<string>();
      for (const el of assistantBubbles()) {
        const m = (el.textContent ?? "").match(NONCE_RE);
        if (m) seenNonces.add(m[0]);
      }

      const probe = {
        t0: performance.now(),
        firstRenderMs: null as number | null,
        fullRenderMs: null as number | null,
        observer: null as unknown as MutationObserver,
        turnNonce: null as string | null,
      };

      const check = () => {
        // Find the bubble carrying a NEW nonce (this turn's reply).
        if (probe.turnNonce === null) {
          for (const el of assistantBubbles()) {
            const m = (el.textContent ?? "").match(NONCE_RE);
            if (m && !seenNonces.has(m[0])) {
              probe.turnNonce = m[0];
              if (probe.firstRenderMs === null) {
                probe.firstRenderMs = performance.now() - probe.t0;
              }
              break;
            }
          }
        }
        // Once we know this turn's nonce, watch ITS bubble for the final marker.
        if (probe.turnNonce !== null && probe.fullRenderMs === null) {
          for (const el of assistantBubbles()) {
            const text = el.textContent ?? "";
            if (
              text.includes(probe.turnNonce) &&
              text.includes(finalText.trim())
            ) {
              probe.fullRenderMs = performance.now() - probe.t0;
              break;
            }
          }
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      probe.observer = observer;
      w.__ELIZA_TURN_PROBE__ = probe;
    },
    {
      finalText: options.finalText,
    },
  );

  await page.getByTestId("chat-composer-action").click();

  // Wait until the probe has observed THIS turn's reply fully render. Tying the
  // wait to the nonce-scoped probe (not a bare hasText locator) is robust to the
  // prior turn's bubble carrying the same final marker text.
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __ELIZA_TURN_PROBE__?: { fullRenderMs: number | null };
      };
      return (w.__ELIZA_TURN_PROBE__?.fullRenderMs ?? null) !== null;
    },
    undefined,
    { timeout: 30_000 },
  );

  const measured = await page.evaluate(() => {
    const w = window as unknown as {
      __ELIZA_TURN_PROBE__?: {
        firstRenderMs: number | null;
        fullRenderMs: number | null;
        observer: MutationObserver;
      };
      __ELIZA_LATENCY_STREAMS__?: Array<{
        chunkCount: number;
        firstChunkAtMs: number;
        lastChunkAtMs: number;
      }>;
    };
    w.__ELIZA_TURN_PROBE__?.observer.disconnect();
    const p = w.__ELIZA_TURN_PROBE__;
    const stream = w.__ELIZA_LATENCY_STREAMS__?.at(-1) ?? null;
    return {
      firstRenderMs: p?.firstRenderMs ?? null,
      fullRenderMs: p?.fullRenderMs ?? null,
      serverChunks: stream?.chunkCount ?? 0,
      serverSpreadMs: stream
        ? Math.max(0, stream.lastChunkAtMs - stream.firstChunkAtMs)
        : 0,
    };
  });

  if (measured.firstRenderMs === null) {
    throw new Error(
      `[chat-latency] turn ${options.turn}: assistant text never rendered`,
    );
  }

  return {
    turn: options.turn,
    afterIdle: options.afterIdle,
    firstRenderMs: measured.firstRenderMs,
    fullRenderMs: measured.fullRenderMs ?? measured.firstRenderMs,
    serverChunks: measured.serverChunks,
    serverSpreadMs: measured.serverSpreadMs,
  };
}

/** Nearest-rank p95, mirrors frame-kpi.ts. */
export function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function annotateSample(
  testInfo: TestInfo,
  sample: ChatLatencySample,
): void {
  testInfo.annotations.push({
    type: "chat-latency",
    description:
      `turn ${sample.turn}${sample.afterIdle ? " (post-idle)" : " (cold)"}: ` +
      `first-render ${Math.round(sample.firstRenderMs)}ms, ` +
      `full-render ${Math.round(sample.fullRenderMs)}ms, ` +
      `${sample.serverChunks} chunks over ${Math.round(sample.serverSpreadMs)}ms`,
  });
}
