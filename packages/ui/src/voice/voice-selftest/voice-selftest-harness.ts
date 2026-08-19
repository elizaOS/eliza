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

import { wordErrorRate } from "@elizaos/shared/voice-wer";
import type { ElizaClient } from "../../api/client-base";
import { fetchWithCsrf } from "../../api/csrf-client";
import { resolveApiUrl } from "../../utils";
import { reportRendererDiagnostic } from "../../utils/renderer-diagnostics";
import { startLocalAsrRecorder } from "../local-asr-capture";
import {
  isLocalInferenceAsrReady,
  transcribeLocalInferenceWav,
} from "../local-asr-transcribe";
import { classifyErrorFallbackReply } from "./error-fallback-reply";
import { now, sleep } from "./timing";

/** Re-exported from the single source of truth (`@elizaos/shared/voice-wer`). */
export { wordErrorRate };

export type StageStatus = "pass" | "fail" | "skipped";
export type VoiceSelfTestMode =
  | "wav-direct"
  | "mic-capture"
  | "inject-transcript";
export type VoiceSelfTestPlatform = "web" | "android" | "desktop" | "ios";

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
  /**
   * Which backend served the SEND reply: `local-inference:<model id>` when
   * the SSE done event carried local-inference metadata, else
   * `remote-provider`. Absent when the SEND stage never produced a reply.
   */
  sendBackend?: string;
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
  /** Exact browser media-device id required by physical-hardware lanes. */
  microphoneDeviceId?: string;
  /** Exact browser output-device id required by physical-hardware lanes. */
  speakerDeviceId?: string;
  /** Receives the exact input/TTS payload bytes for out-of-process evidence. */
  onArtifact?: (
    kind: "microphone" | "reference" | "tts",
    bytes: Uint8Array,
  ) => void;
  client: ElizaClient;
  audioCtx: AudioContext;
  signal?: AbortSignal;
}

/**
 * Real getUserMedia capture. Hardware lanes deliberately play the known phrase
 * through the selected output while this recorder is live; fake-device browser
 * lanes continue to receive the same phrase from Chromium's injected device.
 */
async function captureMicWav(opts: VoiceSelfTestOptions): Promise<{
  wav: Uint8Array;
  captureStartedAt: string;
  captureFinishedAt: string;
  referenceStartedAt: string;
  referenceFinishedAt: string;
  inputDeviceId: string;
  inputDeviceLabel: string;
}> {
  const recorder = await startLocalAsrRecorder({
    deviceId: opts.microphoneDeviceId,
  });
  const captureStartedAt = new Date().toISOString();
  try {
    await sleep(300);
    const fixture = new Uint8Array(
      await (
        await fetch(opts.fixtureUrl, { signal: opts.signal })
      ).arrayBuffer(),
    );
    opts.onArtifact?.("reference", fixture);
    const buffer = await opts.audioCtx.decodeAudioData(fixture.slice().buffer);
    const reference = await playThroughDestination(
      opts.audioCtx,
      buffer,
      opts.signal,
      opts.speakerDeviceId,
    );
    if (!reference.started || !reference.outputObserved) {
      throw new Error("Known-phrase physical output was not observed");
    }
    await sleep(300);
    const wav = await recorder.stop();
    return {
      wav,
      captureStartedAt,
      captureFinishedAt: new Date().toISOString(),
      referenceStartedAt: reference.startedAt,
      referenceFinishedAt: reference.finishedAt,
      inputDeviceId: recorder.inputDevice.deviceId,
      inputDeviceLabel: recorder.inputDevice.label,
    };
  } catch (error) {
    recorder.cancel();
    throw error;
  }
}

/**
 * Peak + RMS amplitude across every channel of a decoded buffer. A buffer of
 * pure silence decodes fine and reports a positive `duration`, so duration
 * alone never proves the TTS produced audible sound — these levels do.
 */
function measureBufferLevel(buffer: AudioBuffer): {
  peak: number;
  rms: number;
} {
  let peak = 0;
  let sumSquares = 0;
  let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const v = Math.abs(data[i] ?? 0);
      if (v > peak) peak = v;
      sumSquares += v * v;
      count += 1;
    }
  }
  return { peak, rms: count > 0 ? Math.sqrt(sumSquares / count) : 0 };
}

/**
 * Push the decoded buffer through a real source → analyser → destination graph
 * (the same shape `useVoiceChat` uses) so the actual speaker path — Web Audio →
 * WebView → Android AudioTrack — is exercised, not just `decodeAudioData`.
 * `started` is a hard signal (the graph began playing without throwing);
 * `outputObserved` is best-effort — on a no-audio CI device the render thread
 * may not advance, which must not fail the stage since the non-silent buffer
 * check already proved the content is audible.
 */
async function playThroughDestination(
  ctx: AudioContext,
  buffer: AudioBuffer,
  signal?: AbortSignal,
  speakerDeviceId?: string,
): Promise<{
  started: boolean;
  outputObserved: boolean;
  startedAt: string;
  finishedAt: string;
  outputDeviceId: string;
}> {
  let startedAt = "";
  let source: AudioBufferSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  try {
    if (ctx.state === "suspended") {
      // error-policy:J4 a stuck-suspended context surfaces as started:false /
      // outputObserved:false in the returned playback result
      await ctx.resume().catch((error) => {
        reportRendererDiagnostic({
          scope: "voice-selftest.audio-context-resume",
          severity: "warning",
          error,
        });
      });
      if (ctx.state === "suspended") {
        throw new Error(
          "AudioContext remained suspended before playback probe",
        );
      }
    }
    const selectable = ctx as AudioContext & {
      setSinkId?: (sinkId: string) => Promise<void>;
      sinkId?: string;
    };
    if (speakerDeviceId) {
      if (typeof selectable.setSinkId !== "function") {
        throw new Error("AudioContext output-device selection is unavailable");
      }
      await selectable.setSinkId(speakerDeviceId);
      if (selectable.sinkId !== speakerDeviceId) {
        throw new Error(
          `Speaker device binding mismatch: requested ${speakerDeviceId}, ` +
            `selected ${selectable.sinkId || "<missing>"}`,
        );
      }
    }
    const activeSource = ctx.createBufferSource();
    source = activeSource;
    activeSource.buffer = buffer;
    const activeAnalyser = ctx.createAnalyser();
    analyser = activeAnalyser;
    activeAnalyser.fftSize = 2048;
    activeSource.connect(activeAnalyser);
    activeAnalyser.connect(ctx.destination);
    const ended = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("audio output did not finish")),
        Math.min(30_000, Math.ceil(buffer.duration * 1_000) + 2_000),
      );
      activeSource.addEventListener(
        "ended",
        () => {
          window.clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
    });
    startedAt = new Date().toISOString();
    activeSource.start();

    let outputObserved = false;
    const probe = new Float32Array(activeAnalyser.fftSize);
    const deadline = now() + 500;
    while (now() < deadline && !outputObserved && !signal?.aborted) {
      activeAnalyser.getFloatTimeDomainData(probe);
      for (let i = 0; i < probe.length; i += 1) {
        if (Math.abs(probe[i] ?? 0) > 1e-4) {
          outputObserved = true;
          break;
        }
      }
      if (!outputObserved) await sleep(20);
    }
    await ended;
    activeSource.disconnect();
    activeAnalyser.disconnect();
    return {
      started: true,
      outputObserved,
      startedAt: startedAt || new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outputDeviceId: selectable.sinkId ?? "default",
    };
  } catch {
    try {
      source?.stop();
    } catch {
      // error-policy:J6 teardown — source already ended
    }
    source?.disconnect();
    analyser?.disconnect();
    // error-policy:J1 playback-stage boundary — the failure is the explicit
    // started:false result the report renders
    return {
      started: false,
      outputObserved: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      outputDeviceId: "",
    };
  }
}

export async function runVoiceSelfTest(
  opts: VoiceSelfTestOptions,
): Promise<VoiceSelfTestReport> {
  const mode = opts.mode ?? "wav-direct";
  const werTolerance = opts.werTolerance ?? 0.34;
  const stages: VoiceSelfTestStage[] = [];
  const startedAt = new Date().toISOString();
  let transcript = "";
  let reply = "";
  let sendBackend: string | undefined;

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
        const capture =
          mode === "mic-capture" ? await captureMicWav(opts) : null;
        const wav =
          capture?.wav ??
          new Uint8Array(
            await (
              await fetch(opts.fixtureUrl, { signal: opts.signal })
            ).arrayBuffer(),
          );
        opts.onArtifact?.("microphone", wav);
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
            ...(capture
              ? {
                  captureStartedAt: capture.captureStartedAt,
                  captureFinishedAt: capture.captureFinishedAt,
                  referenceStartedAt: capture.referenceStartedAt,
                  referenceFinishedAt: capture.referenceFinishedAt,
                  inputDeviceId: capture.inputDeviceId,
                  inputDeviceLabel: capture.inputDeviceLabel,
                }
              : {}),
          },
        });
      }
    } catch (error) {
      // error-policy:J1 stage boundary — failure becomes a fail stage row
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
      // Record which backend actually served the reply: the SSE done event
      // carries local-inference metadata when the local engine answered.
      sendBackend = send.localInference
        ? `local-inference:${
            send.localInference.activeModelId ??
            send.localInference.modelId ??
            send.localInference.provider ??
            "unknown-model"
          }`
        : "remote-provider";
      // Honesty gate (#10726): a completed stream with text is NOT enough —
      // on provider failure the server substitutes a synthetic fallback reply
      // and the old check reported `send: pass`. Fail on the structured
      // `failureKind` first, then on a recognized fallback-reply text.
      const fallbackReplyKind = classifyErrorFallbackReply(reply);
      const failureKind = send.failureKind ?? null;
      const ok =
        send.completed &&
        reply.length > 0 &&
        failureKind === null &&
        fallbackReplyKind === null;
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
          backend: sendBackend,
          ...(send.messageId ? { messageId: send.messageId } : {}),
          ...(send.userMessageId ? { userMessageId: send.userMessageId } : {}),
          ...(failureKind ? { failureKind } : {}),
          ...(fallbackReplyKind ? { fallbackReplyKind } : {}),
        },
        error: ok
          ? undefined
          : failureKind
            ? `server reported a chat failure (failureKind: ${failureKind})`
            : fallbackReplyKind
              ? `reply is a known error-fallback text (${fallbackReplyKind}), not a model reply`
              : "agent produced no reply / did not complete",
      });
    } catch (error) {
      // error-policy:J1 stage boundary — failure becomes a fail stage row
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
      opts.onArtifact?.("tts", new Uint8Array(bytes));
      const audioBuffer = await opts.audioCtx.decodeAudioData(bytes.slice(0));
      const { peak, rms } = measureBufferLevel(audioBuffer);
      // Require real signal, not just a positive duration: synthesized speech
      // peaks near full-scale and its RMS sits well above the quantization
      // floor. A silent (all-zero) buffer would otherwise false-green.
      const nonSilent = peak >= 0.02 && rms >= 1e-4;
      // Exercise the real playback path (source → destination) that drives the
      // device speaker, so "it plays out the speakers" is verified end to end.
      const playback = await playThroughDestination(
        opts.audioCtx,
        audioBuffer,
        opts.signal,
        opts.speakerDeviceId,
      );
      const ok = audioBuffer.duration > 0 && nonSilent && playback.started;
      stages.push({
        stage: "tts",
        status: ok ? "pass" : "fail",
        durationMs: Math.round(now() - t0),
        detail: {
          route: opts.ttsRoute,
          audioBytes: bytes.byteLength,
          durationSec: Number(audioBuffer.duration.toFixed(3)),
          peak: Number(peak.toFixed(4)),
          rms: Number(rms.toFixed(5)),
          played: playback.started,
          outputObserved: playback.outputObserved,
          playbackStartedAt: playback.startedAt,
          playbackFinishedAt: playback.finishedAt,
          outputDeviceId: playback.outputDeviceId,
        },
        error: ok
          ? undefined
          : !nonSilent
            ? `TTS audio is silent (peak=${peak.toFixed(4)}, rms=${rms.toFixed(5)})`
            : !playback.started
              ? "playback graph did not start"
              : "decoded audio has zero duration",
      });
    } catch (error) {
      // error-policy:J1 stage boundary — failure becomes a fail stage row
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
    ...(sendBackend ? { sendBackend } : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
    stages,
  };
}
