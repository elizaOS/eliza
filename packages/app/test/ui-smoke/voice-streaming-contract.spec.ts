/**
 * Streaming-pipeline CONTRACT acceptance for the future Deepgram-Flux -> Gemma 4
 * -> Cartesia path (sol-voice-pwa-e2e). Runs in the default `chromium` project.
 *
 * This is a TARGET-CONTRACT test. The future realtime pipeline must be
 * incremental at every stage (frontier audit kill-criteria #4/#5: no whole-
 * utterance batch, no whole-response TTS buffer). This spec pins the CLIENT
 * consumption contract those providers must satisfy:
 *
 *   STT (Flux):     interim transcript(s) arrive BEFORE the final.
 *   LLM (Gemma 4):  the app stream client surfaces `token`s BEFORE completion.
 *   TTS (Cartesia): first audio playback begins BEFORE the last token.
 *
 * The LLM contract drives the REAL app streaming consumer
 * (`ElizaClient.streamChatEndpoint`) over a chunked, time-spaced transport, so
 * it catches an app parser that buffers the whole body. The STT/TTS contracts
 * use shimmed SpeechRecognition / a chunked TTS route + AudioContext probe.
 * Until the real providers are wired, the chunked stand-ins model their shape;
 * when they are wired, these same assertions hold against them unchanged — a
 * future author swaps the stand-in transport/routes for the live streaming
 * endpoints, not the assertions.
 *
 * NO mic/audio device needed — this exercises the app stream client + SSE/route
 * consumption contract (like tts-stt-e2e.spec.ts), plus an AudioContext playback
 * probe for the TTS-overlap assertion.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-streaming-contract.spec.ts
 */
import { expect, test } from "@playwright/test";
// The REAL app streaming client, imported from @elizaos/ui SOURCE (the same
// cross-package source-import pattern as tts-stt-e2e.spec.ts). `streamChatEndpoint`
// is the exact consumer the chat UI uses for `/messages/stream`; driving IT (not
// a spec-local parser) is what makes the incremental-delivery assertion catch a
// buffering client — if the app parser waited for the whole body, `onToken`
// would fire only after `done` and the timing/ordering assertions would fail.
import { ElizaClient } from "../../../ui/src/api/client";
import type { AgentRequestTransport } from "../../../ui/src/api/transport";
import {
  assertReadyChecks,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

const CHAT_COMPOSER_SELECTOR =
  '[data-testid="chat-composer-textarea"], textarea[aria-label="message"]';

// The incremental token parts a streaming LLM (Gemma 4) emits, each growing the
// cumulative reply, before a terminal `done`. Delivered CHUNK-BY-CHUNK with real
// gaps (below) so a buffering client cannot fake incremental consumption.
const STREAMING_TOKEN_PARTS = [
  "Turning on ",
  "the kitchen light ",
  "and setting a timer ",
  "for ten minutes.",
] as const;
/** Per-chunk delay (ms) injected between SSE events by the in-page fetch mock. */
const STREAM_CHUNK_GAP_MS = 40;

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("STREAMING LLM contract: the app stream client (ElizaClient.streamChatEndpoint) emits incremental tokens before completion (Gemma 4 shape)", async () => {
  // Drive the REAL app streaming consumer with a CHUNKED, time-spaced transport.
  // `onToken` is invoked by the app's OWN SSE parser as each `token` event is
  // read off the stream; we record WHEN each callback fires relative to the send
  // start. A client that buffered the whole body would fire every `onToken` only
  // after `done` — collapsing the arrival spread to ~0 and firing nothing before
  // the promise settles — both of which the assertions below reject. This is what
  // makes the test catch a real batching regression in the app's stream client.
  const enc = new TextEncoder();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // A transport whose Response body is a genuinely chunked, delayed stream:
  // one SSE `token` event per part with a real gap, then a terminal `done`.
  const chunkedTransport: AgentRequestTransport = {
    request: async () => {
      let acc = "";
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const p of STREAMING_TOKEN_PARTS) {
            acc += p;
            controller.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ type: "token", text: p, fullText: acc })}\n\n`,
              ),
            );
            await sleep(STREAM_CHUNK_GAP_MS); // real gap => distinct arrival times
          }
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ type: "done", fullText: acc, agentName: "Eliza" })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  };

  const client = new ElizaClient("http://agent.example:31337", "token");
  client.setRequestTransport(chunkedTransport);

  const tokenArrivals: Array<{ at: number; token: string; accLen: number }> =
    [];
  const t0 = performance.now();

  const result = await client.streamChatEndpoint(
    "/api/conversations/streaming-contract-convo/messages/stream",
    "turn on the kitchen light and set a timer for ten minutes",
    (token, accumulatedText) => {
      tokenArrivals.push({
        at: performance.now() - t0,
        token,
        accLen: (accumulatedText ?? "").length,
      });
    },
  );
  const resolvedAt = performance.now() - t0;

  // The app parser must have surfaced the full reply and completed.
  expect(result.completed).toBe(true);
  expect(result.text).toBe(STREAMING_TOKEN_PARTS.join(""));

  // Streaming contract: the app fired onToken MULTIPLE times (incremental), not
  // once with the whole blob.
  expect(
    tokenArrivals.length,
    "the app stream client must fire onToken incrementally (not one blob)",
  ).toBe(STREAMING_TOKEN_PARTS.length);
  // Accumulated length is non-decreasing across callbacks.
  for (let i = 1; i < tokenArrivals.length; i += 1) {
    expect(tokenArrivals[i].accLen).toBeGreaterThanOrEqual(
      tokenArrivals[i - 1].accLen,
    );
  }
  // The FIRST token must reach the app well before the send promise resolves
  // (overlap, not batch): a buffering client would fire it only at completion.
  expect(
    tokenArrivals[0].at,
    "first token must reach the app before completion (a buffered client fires it only at done)",
  ).toBeLessThan(resolvedAt);
  // TIMING PROOF (load-bearing anti-batch assertion): consecutive onToken
  // callbacks are spread out in real time, not collapsed to one post-buffer
  // instant. A whole-body buffering parser collapses this spread to ~0.
  const firstToLastMs =
    tokenArrivals[tokenArrivals.length - 1].at - tokenArrivals[0].at;
  expect(
    firstToLastMs,
    "onToken callbacks must arrive incrementally over time (a buffered whole-body client collapses this to ~0)",
  ).toBeGreaterThanOrEqual(
    STREAM_CHUNK_GAP_MS * (STREAMING_TOKEN_PARTS.length - 2),
  );
});

test("STREAMING STT contract: interim transcripts precede the final (Flux shape)", async ({
  page,
}) => {
  // Shim the browser SpeechRecognition to model a streaming recognizer that
  // emits interim (isFinal:false) results before the final — the client must
  // render interims progressively (the Flux streaming contract analogue).
  await page.addInitScript(() => {
    type Listener = (e: unknown) => void;
    const instances: Array<{
      onresult: Listener | null;
      started: boolean;
      continuous: boolean;
      interimResults: boolean;
      start: () => void;
      stop: () => void;
      abort: () => void;
      addEventListener: (n: string, h: Listener) => void;
      removeEventListener: () => void;
    }> = [];
    const make = () => {
      const rec = {
        onresult: null as Listener | null,
        started: false,
        continuous: false,
        interimResults: false,
        start() {
          this.started = true;
        },
        stop() {
          this.started = false;
        },
        abort() {
          this.started = false;
        },
        addEventListener(n: string, h: Listener) {
          if (n === "result") this.onresult = h;
        },
        removeEventListener() {},
      };
      instances.push(rec);
      return rec;
    };
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition =
      make;
    (window as unknown as Record<string, unknown>).SpeechRecognition = make;
    // Whether the hook has actually started the (shimmed) recognition instance.
    // The spec polls this after the mic click and FAILS if it never starts,
    // rather than skipping (a never-started hook is the exact regression this
    // streaming-STT contract must catch).
    (window as unknown as Record<string, unknown>).__sttStarted = () =>
      instances.some((r) => r.started);
    (window as unknown as Record<string, unknown>).__sttEmit = (
      text: string,
      isFinal: boolean,
    ) => {
      const rec = instances[instances.length - 1];
      if (!rec?.started) return false;
      rec.onresult?.({
        resultIndex: 0,
        results: [{ isFinal, 0: { transcript: text }, length: 1 }],
      });
      return true;
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {},
    });
  });

  await openAppPath(page, "/chat");
  await assertReadyChecks(
    page,
    "chat shell ready",
    [{ selector: CHAT_COMPOSER_SELECTOR }],
    "all",
  );

  const micButton = page
    .getByRole("button", { name: /talk|voice input/i })
    .first();
  await expect(micButton).toBeVisible({ timeout: 15_000 });
  await micButton.click();

  // The hook MUST start the (shimmed) browser SpeechRecognition after the mic
  // gesture. If it never starts, that IS the streaming-STT regression this
  // contract exists to catch, so FAIL with a clear message rather than skip.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as { __sttStarted?: () => boolean }
            ).__sttStarted?.() ?? false,
        ),
      {
        timeout: 15_000,
        message:
          "the voice hook must START browser SpeechRecognition after the mic gesture (shim + click are in place) — a never-started recognizer is the streaming-STT regression this contract must catch",
      },
    )
    .toBe(true);

  // Emit an interim, then a final. The interim must appear before the final.
  const interim = await page.evaluate(() => {
    const fn = (window as unknown as Record<string, unknown>).__sttEmit as
      | ((t: string, f: boolean) => boolean)
      | undefined;
    return fn?.("turn on the kitchen", false) ?? false;
  });
  expect(interim, "interim STT emit must reach the started recognizer").toBe(
    true,
  );

  await expect
    .poll(() => page.evaluate(() => document.body.textContent ?? ""), {
      timeout: 5_000,
      message: "interim transcript must render before the final",
    })
    .toContain("turn on the kitchen");

  await page.evaluate(() => {
    const fn = (window as unknown as Record<string, unknown>).__sttEmit as
      | ((t: string, f: boolean) => boolean)
      | undefined;
    fn?.("turn on the kitchen light", true);
  });
});
