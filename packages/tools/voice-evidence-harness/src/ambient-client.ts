/**
 * Harness AMBIENT voice-session client (AMBIENT-MODE-DESIGN).
 *
 * Speaks the ambient contract against the REAL ambient server path: mints an
 * ambient session (mode:"ambient", bound pendantSessionId + captureLeaseToken),
 * opens WS, sends the ambient `hello`, streams TWO utterances with a `pause`/
 * `resume` between them, records every s2c ambient event (stt_final/
 * segment_committed/paused/resumed/lease_renewed/usage), and at the end asserts
 * NO downlink audio was ever received (ambient has an empty downlink).
 *
 * The revoke-severs-socket assertion is driven server-side by the CLI (it holds
 * the registry); this client records the socket close it observes.
 */

import { DEEPGRAM_FLUX_CHUNK_BYTES } from "@harness-adapters/deepgram-flux.ts";
import type { Evidence } from "./evidence.ts";
import { frameFixedChunks } from "./wav.ts";

export interface AmbientClientRunOptions {
  wsUrl: string;
  token: string;
  pendantSessionId: string;
  captureLeaseToken: string;
  /** Two utterances (linear16 mono 16k) captured with a pause between. */
  utterancePcms: Uint8Array[];
  evidence: Evidence;
  maxRunMs?: number;
  /**
   * Called after capture completes. The CLI uses it to drive a revoke; the
   * client then waits (bounded) for the resulting socket close and records the
   * time-to-silence. Should resolve once the revoke has been issued.
   */
  onCaptureComplete?: () => Promise<void> | void;
}

export interface AmbientClientRunResult {
  sawReady: boolean;
  sttFinals: Array<{ text: string; ordinal: number; segmentId: string }>;
  segmentCommitted: number;
  sawPaused: boolean;
  sawResumed: boolean;
  sawLeaseRenewed: boolean;
  /** MUST stay 0: ambient has no downlink audio. */
  downlinkAudioFrames: number;
  errors: Array<{ code: string; retryable: boolean }>;
  closed: boolean;
  /** ms from issuing the revoke to the socket closing (revoke-to-silence). */
  revokeToCloseMs: number | null;
}

export async function runAmbientClient(
  opts: AmbientClientRunOptions,
): Promise<AmbientClientRunResult> {
  const { evidence: ev } = opts;
  const NativeWebSocket = WebSocket as unknown as new (u: string) => WebSocket;
  const ws = new NativeWebSocket(opts.wsUrl);
  (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";

  const result: AmbientClientRunResult = {
    sawReady: false,
    sttFinals: [],
    segmentCommitted: 0,
    sawPaused: false,
    sawResumed: false,
    sawLeaseRenewed: false,
    downlinkAudioFrames: 0,
    errors: [],
    closed: false,
    revokeToCloseMs: null,
  };
  let revokeIssuedMonoMs: number | null = null;

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const maxRunMs = opts.maxRunMs ?? 60_000;
  const guard = setTimeout(() => {
    ev.log("client", "warn", "ambient max run time reached, closing");
    finish();
  }, maxRunMs);

  function finish() {
    clearTimeout(guard);
    try {
      ws.close();
    } catch {
      /* noop */
    }
    resolveDone();
  }

  ws.addEventListener("open", () => {
    ev.log("client", "info", "ambient ws open");
    const hello = {
      t: "hello",
      mode: "ambient",
      token: opts.token,
      protocol: 1,
      pendantSessionId: opts.pendantSessionId,
      captureLeaseToken: opts.captureLeaseToken,
      uplinkCodec: "pcm16",
      sampleRate: 16000,
    };
    ev.wsEvent("c2s", "json", { ...hello, token: "<REDACTED>", captureLeaseToken: "<REDACTED>" });
    ws.send(JSON.stringify(hello));
    ev.mark("ws_hello");
  });

  ws.addEventListener("message", async (event: MessageEvent) => {
    const data = (event as MessageEvent).data;
    if (data instanceof ArrayBuffer) {
      // ANY binary downlink frame is a contract violation in ambient.
      result.downlinkAudioFrames++;
      ev.log("client", "error", "AMBIENT downlink audio frame (must be zero)", {
        byteLength: (data as ArrayBuffer).byteLength,
      });
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    ev.wsEvent("s2c", "json", msg);
    switch (msg.t as string) {
      case "ready":
        result.sawReady = true;
        ev.mark("ready");
        ev.log("client", "info", "ambient ready", { pendantSessionId: msg.pendantSessionId });
        await runCapture();
        break;
      case "stt_partial":
        ev.mark("stt_first_partial");
        break;
      case "stt_final":
        result.sttFinals.push({
          text: String(msg.text),
          ordinal: Number(msg.ordinal),
          segmentId: String(msg.segmentId),
        });
        ev.mark(result.sttFinals.length === 1 ? "first_segment" : "second_segment");
        ev.log("client", "info", "stt_final", { text: msg.text, ordinal: msg.ordinal });
        break;
      case "segment_committed":
        result.segmentCommitted++;
        break;
      case "paused":
        result.sawPaused = true;
        ev.mark("paused");
        ev.log("client", "info", "paused (Flux severed)");
        break;
      case "resumed":
        result.sawResumed = true;
        ev.mark("resumed");
        break;
      case "lease_renewed":
        result.sawLeaseRenewed = true;
        ev.log("client", "info", "lease_renewed");
        break;
      case "usage":
        ev.log("client", "info", "usage", { sttMs: msg.sttMs });
        break;
      case "error":
        result.errors.push({ code: String(msg.code), retryable: Boolean(msg.retryable) });
        ev.log("client", "error", "ambient server error", { code: msg.code });
        break;
    }
  });

  ws.addEventListener("error", () => ev.log("client", "error", "ambient ws transport error"));
  ws.addEventListener("close", () => {
    result.closed = true;
    if (revokeIssuedMonoMs !== null) {
      result.revokeToCloseMs = performance.now() - ev.startMono - revokeIssuedMonoMs;
      ev.mark("revoke_to_silence");
      ev.log("client", "info", "socket closed after revoke", {
        revokeToCloseMs: result.revokeToCloseMs,
      });
    }
    ev.log("client", "info", "ambient ws close");
    finish();
  });

  async function streamUtterance(pcm: Uint8Array, label: string): Promise<void> {
    const { chunks } = frameFixedChunks(pcm, DEEPGRAM_FLUX_CHUNK_BYTES);
    ev.log("client", "info", `streaming ${label}`, { chunks: chunks.length });
    for (const chunk of chunks) {
      if (ws.readyState !== 1) return;
      ws.send(chunk);
      await sleep(50);
    }
    // Trailing real silence so Flux fires a semantic end-of-turn (segment commit).
    const silence = new Uint8Array(DEEPGRAM_FLUX_CHUNK_BYTES);
    for (let i = 0; i < 18; i++) {
      if (ws.readyState !== 1) return;
      ws.send(silence);
      await sleep(50);
    }
  }

  async function runCapture(): Promise<void> {
    // Utterance 1.
    await streamUtterance(opts.utterancePcms[0], "utterance-1");
    await sleep(600);

    // Renew the lease over the socket mid-session (design §1.4 / SEC-7).
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "lease_renew" }));
      ev.wsEvent("c2s", "json", { t: "lease_renew" });
      await sleep(300);
    }

    // Pause (severs Flux), hold, then resume (design §1.2).
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "pause" }));
      ev.wsEvent("c2s", "json", { t: "pause" });
      await sleep(500);
      ws.send(JSON.stringify({ t: "resume" }));
      ev.wsEvent("c2s", "json", { t: "resume" });
      await sleep(400);
    }

    // Utterance 2 (after resume).
    await streamUtterance(opts.utterancePcms[1] ?? opts.utterancePcms[0], "utterance-2");
    await sleep(1200);

    // Signal end; drive the revoke-severs-socket assertion (SEC-6).
    ev.mark("capture_complete");
    ev.log("client", "info", "ambient capture complete; issuing revoke");
    if (opts.onCaptureComplete) {
      revokeIssuedMonoMs = performance.now() - ev.startMono;
      await opts.onCaptureComplete();
      // The AmbientSession's revocation poll (~400ms) observes the durable
      // revoke and severs Flux + closes the socket; the close handler records
      // revokeToCloseMs. Bound the wait so a missed sever fails loudly.
      setTimeout(() => {
        if (!result.closed) {
          ev.log("client", "error", "socket NOT severed within 2s of revoke");
          finish();
        }
      }, 2000);
    }
  }

  await done;
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
