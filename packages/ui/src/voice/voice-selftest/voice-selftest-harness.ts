/**
 * Self-driving voice round-trip verifier — NO human, NO mocks.
 *
 * Drives the SAME real production functions the chat composer uses
 * (transcribeLocalInferenceWav, ElizaClient.sendConversationMessageStream, a
 * real TTS route + AudioContext.decodeAudioData) against a known audio phrase,
 * and reports a machine-readable per-stage PASS/FAIL. Reused by:
 *   - the in-app voice self-test screen (?shellMode=voice-selftest)
 *   - the web / android / desktop e2e lanes (they navigate to that screen and
 *     scrape `window.__voiceSelfTest()` / the DOM-mirrored report).
 *
 * Three stages: ASR (speech -> text), SEND (text -> agent reply over real SSE),
 * TTS (reply text -> decodable audio). A stage that genuinely cannot run on
 * this host (e.g. local-inference ASR not provisioned) reports `skipped` — NOT
 * `pass` — so CI can tell "can't run here" from "verified working" and never
 * false-greens.
 */

import type { ElizaClient } from "../../api/client-base";
import { fetchWithCsrf } from "../../api/csrf-client";
import { resolveApiUrl } from "../../utils";
import { startLocalAsrRecorder } from "../local-asr-capture";
import {
  isLocalInferenceAsrReady,
  transcribeLocalInferenceWav,
} from "../local-asr-transcribe";

export type StageStatus = "pass" | "fail" | "skipped";
export type VoiceSelfTestMode =
  | "wav-direct"
  | "mic-capture"
  | "inject-transcript";
export type VoiceSelfTestPlatform = "web" | "android" | "desktop";

export interface VoiceSelfTestStage {
  stage: "asr" | "send" | "tts";
  status: StageStatus;
  durationMs: number;
  detail: Record<string, string | number | boolean>;
  error?: string;
}

export interface VoiceSelfTestReport {
  schemaVersion: 1;
  overall: "pass" | "fail" | "skipped";
  platform: VoiceSelfTestPlatform;
  mode: VoiceSelfTestMode;
  ttsRoute: string;
  expectedPhrase: string;
  transcript: string;
  reply: string;
  startedAt: string;
  finishedAt: string;
  stages: VoiceSelfTestStage[];
}

export interface VoiceSelfTestOptions {
  platform: VoiceSelfTestPlatform;
  /** Default `wav-direct`: fetch the bundled WAV and transcribe it directly. */
  mode?: VoiceSelfTestMode;
  /** Bundled 16 kHz mono WAV of the known phrase. */
  fixtureUrl: string;
  /** The phrase the fixture says, for WER scoring. */
  expectedPhrase: string;
  /** TTS route to exercise. local for desktop/local, cloud for web/mobile. */
  ttsRoute: "/api/tts/local-inference" | "/api/tts/cloud";
  /** Extra TTS body fields (e.g. voiceId/modelId for the cloud route). */
  ttsExtraBody?: Record<string, unknown>;
  /** Max word-error-rate the ASR transcript may have vs `expectedPhrase`. */
  werTolerance?: number;
  /** For mode `inject-transcript` (the Android native-STT seam). */
  injectedTranscript?: string;
  client: ElizaClient;
  audioCtx: AudioContext;
  signal?: AbortSignal;
}

function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Levenshtein word-error-rate of `hyp` against `ref`. No dependencies. */
export function wordErrorRate(ref: string, hyp: string): number {
  const r = normalizeWords(ref);
  const h = normalizeWords(hyp);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  const d: number[][] = Array.from({ length: r.length + 1 }, () =>
    new Array<number>(h.length + 1).fill(0),
  );
  for (let i = 0; i <= r.length; i += 1) d[i][0] = i;
  for (let j = 0; j <= h.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= r.length; i += 1) {
    for (let j = 1; j <= h.length; j += 1) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
    }
  }
  return d[r.length][h.length] / r.length;
}

/**
 * Real getUserMedia capture; the runner supplies audio via Chromium fake-device
 * flags. Uses a fixed capture window (deterministic for a known fixture) — the
 * literal button-press path is covered separately by the chat-composer e2e.
 */
async function captureMicWav(signal?: AbortSignal): Promise<Uint8Array> {
  const recorder = await startLocalAsrRecorder();
  return await new Promise<Uint8Array>((resolve, reject) => {
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      recorder.stop().then(resolve, reject);
    };
    const timer = setTimeout(stop, 4500);
    signal?.addEventListener("abort", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      recorder.cancel();
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : 0;

export async function runVoiceSelfTest(
  opts: VoiceSelfTestOptions,
): Promise<VoiceSelfTestReport> {
  const mode = opts.mode ?? "wav-direct";
  const werTolerance = opts.werTolerance ?? 0.34;
  const stages: VoiceSelfTestStage[] = [];
  const startedAt = new Date().toISOString();
  let transcript = "";
  let reply = "";

  // ---- Stage ASR: known audio phrase -> transcript ------------------------
  {
    const t0 = now();
    try {
      if (mode === "inject-transcript") {
        transcript = (opts.injectedTranscript ?? "").trim();
        if (!transcript) throw new Error("injectedTranscript is empty");
        stages.push({
          stage: "asr",
          status: "pass",
          durationMs: Math.round(now() - t0),
          detail: { mode, transcript },
        });
      } else if (!(await isLocalInferenceAsrReady({ signal: opts.signal }))) {
        stages.push({
          stage: "asr",
          status: "skipped",
          durationMs: Math.round(now() - t0),
          detail: {
            mode,
            reason: "local-inference ASR not ready on this host",
          },
        });
      } else {
        const wav =
          mode === "mic-capture"
            ? await captureMicWav(opts.signal)
            : new Uint8Array(
                await (
                  await fetch(opts.fixtureUrl, { signal: opts.signal })
                ).arrayBuffer(),
              );
        const result = await transcribeLocalInferenceWav(wav, {
          signal: opts.signal,
        });
        transcript = result.text;
        const wer = wordErrorRate(opts.expectedPhrase, transcript);
        stages.push({
          stage: "asr",
          status: wer <= werTolerance ? "pass" : "fail",
          durationMs: Math.round(now() - t0),
          detail: {
            mode,
            transcript,
            expectedPhrase: opts.expectedPhrase,
            wer: Number(wer.toFixed(3)),
            werTolerance,
          },
        });
      }
    } catch (error) {
      stages.push({
        stage: "asr",
        status: "fail",
        durationMs: Math.round(now() - t0),
        detail: { mode },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const asrUsable = stages[0].status === "pass" && transcript.trim().length > 0;

  // ---- Stage SEND: transcript -> agent reply over real SSE ----------------
  if (asrUsable) {
    const t0 = now();
    try {
      const { conversation } =
        await opts.client.createConversation("voice-selftest");
      let tokenCount = 0;
      const send = await opts.client.sendConversationMessageStream(
        conversation.id,
        transcript,
        () => {
          tokenCount += 1;
        },
        "VOICE_DM",
        opts.signal,
      );
      reply = (send.text ?? "").trim();
      const ok = send.completed && reply.length > 0;
      stages.push({
        stage: "send",
        status: ok ? "pass" : "fail",
        durationMs: Math.round(now() - t0),
        detail: {
          conversationId: conversation.id,
          tokens: tokenCount,
          replyChars: reply.length,
          completed: send.completed,
          agentName: send.agentName,
        },
        error: ok ? undefined : "agent produced no reply / did not complete",
      });
    } catch (error) {
      stages.push({
        stage: "send",
        status: "fail",
        durationMs: Math.round(now() - t0),
        detail: {},
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    stages.push({
      stage: "send",
      status: "skipped",
      durationMs: 0,
      detail: { reason: "ASR did not produce a usable transcript" },
    });
  }

  // ---- Stage TTS: reply text -> decodable audio ---------------------------
  if (reply.length > 0) {
    const t0 = now();
    try {
      const res = await fetchWithCsrf(resolveApiUrl(opts.ttsRoute), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/*" },
        body: JSON.stringify({ text: reply, ...(opts.ttsExtraBody ?? {}) }),
        signal: opts.signal,
      });
      if (!res.ok) {
        throw new Error(`TTS ${opts.ttsRoute} returned ${res.status}`);
      }
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength === 0) throw new Error("TTS returned empty audio");
      const audioBuffer = await opts.audioCtx.decodeAudioData(bytes.slice(0));
      const ok = audioBuffer.duration > 0;
      stages.push({
        stage: "tts",
        status: ok ? "pass" : "fail",
        durationMs: Math.round(now() - t0),
        detail: {
          route: opts.ttsRoute,
          audioBytes: bytes.byteLength,
          durationSec: Number(audioBuffer.duration.toFixed(3)),
        },
        error: ok ? undefined : "decoded audio has zero duration",
      });
    } catch (error) {
      stages.push({
        stage: "tts",
        status: "fail",
        durationMs: Math.round(now() - t0),
        detail: { route: opts.ttsRoute },
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    stages.push({
      stage: "tts",
      status: "skipped",
      durationMs: 0,
      detail: { reason: "no reply text to synthesize" },
    });
  }

  const hasFail = stages.some((s) => s.status === "fail");
  const allSkipped = stages.every((s) => s.status === "skipped");
  const overall: VoiceSelfTestReport["overall"] = hasFail
    ? "fail"
    : allSkipped
      ? "skipped"
      : "pass";

  return {
    schemaVersion: 1,
    overall,
    platform: opts.platform,
    mode,
    ttsRoute: opts.ttsRoute,
    expectedPhrase: opts.expectedPhrase,
    transcript,
    reply,
    startedAt,
    finishedAt: new Date().toISOString(),
    stages,
  };
}
