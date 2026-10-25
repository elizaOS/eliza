/**
 * Browser instrumentation for the chat client's incremental SSE render path.
 *
 * The transport is deterministic so this isolates parsing, state commits, and
 * React rendering from model and server latency. Production turn latency is
 * measured separately by the runtime inference-timing endpoint.
 */
import type { Page, TestInfo } from "@playwright/test";

export interface ChatStreamRenderSample {
  firstFrameCommitMs: number;
  fullFrameCommitMs: number;
  transportChunks: number;
  transportSpreadMs: number;
  commitsBeforeDone: number;
  distinctLengthsBeforeDone: number;
  firstCommitLeadOverDoneMs: number;
}

export interface ChatStreamFixture {
  tokens: string[];
  firstTokenDelayMs: number;
  intervalMs: number;
}

interface StreamRecord {
  nonce: string;
  chunkCount: number;
  firstChunkAtMs: number;
  lastChunkAtMs: number;
  doneEnqueuedAtMs: number | null;
}

interface CommitRecord {
  atMs: number;
  textLength: number;
}

interface TurnProbe {
  t0: number | null;
  turnNonce: string | null;
  firstFrameCommitMs: number | null;
  fullFrameCommitMs: number | null;
  commits: CommitRecord[];
  observer: MutationObserver;
}

export async function installChatStreamFixture(
  page: Page,
  fixture: ChatStreamFixture,
): Promise<void> {
  await page.addInitScript((fx: ChatStreamFixture) => {
    const state = window as unknown as {
      __ELIZA_STREAM_RECORDS__?: StreamRecord[];
    };
    state.__ELIZA_STREAM_RECORDS__ = [];
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
      if (method !== "POST" || !/\/messages\/stream$/.test(url.pathname)) {
        return originalFetch(input, init);
      }

      sequence += 1;
      const nonce = `⟦stream-${sequence}⟧`;
      const encoder = new TextEncoder();
      const emitTokens = [`${nonce} `, ...fx.tokens];
      const record: StreamRecord = {
        nonce,
        chunkCount: 0,
        firstChunkAtMs: 0,
        lastChunkAtMs: 0,
        doneEnqueuedAtMs: null,
      };
      state.__ELIZA_STREAM_RECORDS__?.push(record);

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
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "token",
                    text: token,
                    fullText,
                  })}\n\n`,
                ),
              );
              window.setTimeout(() => emit(index + 1), fx.intervalMs);
              return;
            }
            record.doneEnqueuedAtMs = performance.now();
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

export async function measureChatStreamRender(
  page: Page,
  options: { message: string; finalText: string },
): Promise<ChatStreamRenderSample> {
  const composer = page.getByTestId("chat-composer-textarea");
  await composer.fill(options.message);

  await page.evaluate(({ finalText }) => {
    const state = window as unknown as {
      __ELIZA_TURN_PROBE__?: TurnProbe;
    };
    state.__ELIZA_TURN_PROBE__?.observer.disconnect();
    const noncePattern = /⟦stream-\d+⟧/;
    const assistantBubbles = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="thread-line"][data-role="assistant"]',
        ),
      );
    const seenNonces = new Set(
      assistantBubbles()
        .map((element) => element.textContent?.match(noncePattern)?.[0])
        .filter((nonce): nonce is string => typeof nonce === "string"),
    );
    const action = document.querySelector<HTMLElement>(
      '[data-testid="chat-composer-action"]',
    );
    if (!action) throw new Error("Chat action button is unavailable");

    let framePending = false;
    const probe: TurnProbe = {
      t0: null,
      turnNonce: null,
      firstFrameCommitMs: null,
      fullFrameCommitMs: null,
      commits: [],
      observer: null as unknown as MutationObserver,
    };
    const sampleFrame = () => {
      framePending = false;
      if (probe.t0 === null) return;
      if (probe.turnNonce === null) {
        for (const element of assistantBubbles()) {
          const nonce = element.textContent?.match(noncePattern)?.[0];
          if (nonce && !seenNonces.has(nonce)) {
            probe.turnNonce = nonce;
            break;
          }
        }
      }
      if (probe.turnNonce === null) return;
      const bubble = assistantBubbles().find((element) =>
        element.textContent?.includes(probe.turnNonce ?? ""),
      );
      if (!bubble) return;
      const text = bubble.textContent ?? "";
      const atMs = performance.now();
      const previousLength = probe.commits.at(-1)?.textLength;
      if (previousLength !== text.length) {
        probe.commits.push({ atMs, textLength: text.length });
      }
      probe.firstFrameCommitMs ??= atMs - probe.t0;
      if (text.includes(finalText.trim())) {
        probe.fullFrameCommitMs ??= atMs - probe.t0;
      }
    };
    const observer = new MutationObserver(() => {
      if (framePending) return;
      framePending = true;
      requestAnimationFrame(sampleFrame);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    probe.observer = observer;
    state.__ELIZA_TURN_PROBE__ = probe;
    action.addEventListener(
      "click",
      () => {
        probe.t0 = performance.now();
      },
      { capture: true, once: true },
    );
  }, options);

  await page.getByTestId("chat-composer-action").click();
  await page.waitForFunction(
    () => {
      const state = window as unknown as {
        __ELIZA_TURN_PROBE__?: TurnProbe;
        __ELIZA_STREAM_RECORDS__?: StreamRecord[];
      };
      return (
        state.__ELIZA_TURN_PROBE__?.fullFrameCommitMs !== null &&
        state.__ELIZA_STREAM_RECORDS__?.at(-1)?.doneEnqueuedAtMs !== null
      );
    },
    undefined,
    { timeout: 8_000 },
  );

  const measured = await page.evaluate(() => {
    const state = window as unknown as {
      __ELIZA_TURN_PROBE__?: TurnProbe;
      __ELIZA_STREAM_RECORDS__?: StreamRecord[];
    };
    const probe = state.__ELIZA_TURN_PROBE__;
    const stream = state.__ELIZA_STREAM_RECORDS__?.at(-1);
    probe?.observer.disconnect();
    if (
      !probe ||
      probe.t0 === null ||
      probe.firstFrameCommitMs === null ||
      probe.fullFrameCommitMs === null ||
      !stream ||
      stream.doneEnqueuedAtMs === null
    ) {
      throw new Error("Incomplete chat stream render measurement");
    }
    const commitsBeforeDone = probe.commits.filter(
      (commit) => commit.atMs < (stream.doneEnqueuedAtMs as number),
    );
    return {
      firstFrameCommitMs: probe.firstFrameCommitMs,
      fullFrameCommitMs: probe.fullFrameCommitMs,
      transportChunks: stream.chunkCount,
      transportSpreadMs: stream.lastChunkAtMs - stream.firstChunkAtMs,
      commitsBeforeDone: commitsBeforeDone.length,
      distinctLengthsBeforeDone: new Set(
        commitsBeforeDone.map((commit) => commit.textLength),
      ).size,
      firstCommitLeadOverDoneMs:
        stream.doneEnqueuedAtMs - (probe.t0 + probe.firstFrameCommitMs),
    };
  });

  return measured;
}

export function annotateChatStreamRender(
  testInfo: TestInfo,
  sample: ChatStreamRenderSample,
): void {
  testInfo.annotations.push({
    type: "chat-stream-render",
    description:
      `first frame commit ${Math.round(sample.firstFrameCommitMs)}ms; ` +
      `${sample.distinctLengthsBeforeDone} incremental renders before done; ` +
      `${Math.round(sample.firstCommitLeadOverDoneMs)}ms lead`,
  });
}
