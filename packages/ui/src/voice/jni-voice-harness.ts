/**
 * On-device JNI voice pipeline verification harness (the normal Android APK).
 *
 * Wires the {@link JniVoicePipeline} to the native TalkMode capture + the
 * `ElizaVoice` JNI host and exposes a control surface on `window.__jniVoice` so
 * the live mic → native VAD/speaker/diariz → attributed-turn round trip can be
 * driven and read on-device via CDP — the same shape as
 * `installDiarizationPumpHarness`, but the four voice ops run IN-PROCESS in the
 * bionic app process instead of over an HTTP hop to the musl bun agent.
 *
 *   window.__jniVoice.start()  → open native pipeline + start mic + pump
 *   window.__jniVoice.status() → { running, framesSent, turnsObserved, abi, turns[] }
 *   window.__jniVoice.stop()   → stop capture, flush the open turn, free handles
 *
 * Install-once and inert off Android. When started, completed PCM turns are
 * forwarded through the local-agent bridge so the agent-side fused voice turn
 * pipeline owns ASR/text/TTS while this harness remains observable on-device.
 */

import { ElizaClient } from "../api";
import {
  getElizaVoicePlugin,
  getTalkModePlugin,
} from "../bridge/native-plugins";
import { MOBILE_LOCAL_AGENT_API_BASE } from "../first-run/mobile-runtime-mode";
import {
  type JniAttributedTurn,
  type JniCompletedPcmTurn,
  JniVoicePipeline,
  type JniVoicePipelineOptions,
} from "./jni-voice-pipeline";

declare global {
  interface Window {
    __jniVoice?: JniVoiceControl;
  }
}

export interface JniVoiceTurnSummary {
  turnId: string;
  durationMs: number;
  embeddingNorm: number;
  diarizDistinctClasses: number;
  agentShouldSpeak: boolean;
  nextSpeaker: string;
}

export interface JniVoiceStatus {
  running: boolean;
  framesSent: number;
  /**
   * AEC far-end delivery counter: native `playbackFrame` events (the
   * TalkMode AudioTrack tap) consumed by the pipeline's echo reference.
   * Zero while the agent has not spoken; must be > 0 during/after native TTS
   * playback for the echo canceller to have a live far-end (#11373).
   */
  playbackFramesReceived: number;
  /** ERLE (dB) of the most recent echo-cancelled batch. 0 until cancelling. */
  lastEchoErleDb: number;
  turnsObserved: number;
  abi?: Awaited<
    ReturnType<ReturnType<typeof getElizaVoicePlugin>["voiceAbiVersion"]>
  >;
  recentTurns: JniVoiceTurnSummary[];
  error?: string;
}

export interface JniVoiceControl {
  start(): Promise<{ started: boolean; error?: string }>;
  stop(): Promise<{ stopped: boolean; framesSent: number }>;
  status(): Promise<JniVoiceStatus>;
  isRunning(): boolean;
}

export interface JniVoiceHarnessOptions extends JniVoicePipelineOptions {
  /**
   * Forward completed PCM turns to the local agent voice route. Defaults true
   * for the Android app harness; set false for tests or diagnostics that only
   * want attribution summaries.
   */
  forwardCompletedPcmTurns?: boolean;
}

const MAX_RECENT = 20;

let installed = false;
let pipeline: JniVoicePipeline | null = null;
const recentTurns: JniVoiceTurnSummary[] = [];
let handoffController: AbortController | null = null;
const pendingHandoffs = new Set<Promise<void>>();

function recordTurn(turn: JniAttributedTurn): void {
  recentTurns.push({
    turnId: turn.turnId,
    durationMs: turn.durationMs,
    embeddingNorm: turn.embeddingNorm,
    diarizDistinctClasses: turn.diarizDistinctClasses,
    agentShouldSpeak: turn.signal.agentShouldSpeak,
    nextSpeaker: turn.signal.nextSpeaker,
  });
  if (recentTurns.length > MAX_RECENT) recentTurns.shift();
}

function float32ToBase64(pcm: Float32Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

const JNI_VOICE_PCM_TURN_TIMEOUT_MS = 15_000;
const localAgentClient = new ElizaClient(MOBILE_LOCAL_AGENT_API_BASE);

async function drainResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    try {
      await response.body?.cancel(signal.reason);
    } catch {
      // error-policy:J6 the lifecycle abort is authoritative; failure to cancel
      // an already-detached response body must not replace its abort reason.
    }
  }
  signal.throwIfAborted();
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const cancel = () => {
    // error-policy:J5 the awaiting read below observes the same cancellation
    // through signal.throwIfAborted; cancellation rejection needs no second path.
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!(await reader.read()).done) {
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function forwardCompletedPcmTurnToLocalAgent(
  turn: JniCompletedPcmTurn,
  lifecycleSignal: AbortSignal,
): Promise<void> {
  lifecycleSignal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(lifecycleSignal.reason);
  lifecycleSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(
      new DOMException("Native PCM handoff timed out", "TimeoutError"),
    );
  }, JNI_VOICE_PCM_TURN_TIMEOUT_MS);

  try {
    const response = await localAgentClient.rawRequest(
      "/api/voice/native-pcm-turn",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          turnId: turn.turnId,
          pcm: float32ToBase64(turn.audio.pcm),
          sampleRate: turn.audio.sampleRate,
          signal: turn.signal,
        }),
        signal: controller.signal,
      },
      { timeoutMs: JNI_VOICE_PCM_TURN_TIMEOUT_MS },
    );
    await drainResponseBody(response, controller.signal);
  } catch (error) {
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timeout);
    lifecycleSignal.removeEventListener("abort", abort);
  }
}

function forwardCompletedPcmTurn(turn: JniCompletedPcmTurn): Promise<void> {
  const controller = handoffController;
  if (!controller) return Promise.resolve();
  const handoff = forwardCompletedPcmTurnToLocalAgent(turn, controller.signal);
  pendingHandoffs.add(handoff);
  void handoff.then(
    () => pendingHandoffs.delete(handoff),
    () => pendingHandoffs.delete(handoff),
  );
  return handoff;
}

function pipelineOptionsForHarness(
  options: JniVoiceHarnessOptions,
): JniVoicePipelineOptions {
  const forward =
    options.forwardCompletedPcmTurns !== false
      ? forwardCompletedPcmTurn
      : undefined;
  return {
    ...options,
    onCompletedPcmTurn: options.onCompletedPcmTurn ?? forward,
  };
}

function getPipeline(options: JniVoiceHarnessOptions = {}): JniVoicePipeline {
  if (!pipeline) {
    pipeline = new JniVoicePipeline(
      getTalkModePlugin(),
      getElizaVoicePlugin(),
      pipelineOptionsForHarness(options),
    );
    pipeline.onTurn(recordTurn);
  }
  return pipeline;
}

/**
 * Attach `window.__jniVoice`. Idempotent. Returns the control surface (also
 * usable directly from app code, not only CDP).
 */
export function installJniVoiceHarness(
  options: JniVoiceHarnessOptions = {},
): JniVoiceControl {
  const control: JniVoiceControl = {
    async start() {
      const p = getPipeline(options);
      if (!p.isRunning) {
        handoffController?.abort(
          new DOMException("JNI voice harness restarted", "AbortError"),
        );
        handoffController = new AbortController();
      }
      try {
        const result = await p.start();
        if (!result.started) {
          handoffController?.abort(
            new DOMException("JNI voice harness did not start", "AbortError"),
          );
          handoffController = null;
        }
        return result;
      } catch (error) {
        handoffController?.abort(error);
        handoffController = null;
        throw error;
      }
    },
    async stop() {
      const p = getPipeline(options);
      const framesSent = p.framesSent;
      handoffController?.abort(
        new DOMException("JNI voice harness stopped", "AbortError"),
      );
      const flushController = new AbortController();
      handoffController = flushController;
      try {
        await p.stop();
        await Promise.allSettled([...pendingHandoffs]);
      } finally {
        flushController.abort(
          new DOMException("JNI voice harness stopped", "AbortError"),
        );
        if (handoffController === flushController) handoffController = null;
      }
      return { stopped: true, framesSent };
    },
    async status() {
      let abi: JniVoiceStatus["abi"];
      try {
        abi = await getElizaVoicePlugin().voiceAbiVersion();
      } catch (err) {
        // error-policy:J1 status boundary — the failure is returned as the
        // structured status' error field
        return {
          running: pipeline?.isRunning ?? false,
          framesSent: pipeline?.framesSent ?? 0,
          playbackFramesReceived: pipeline?.playbackFramesReceived ?? 0,
          lastEchoErleDb: pipeline?.lastEchoErleDb ?? 0,
          turnsObserved: pipeline?.turnsObserved ?? 0,
          recentTurns: [...recentTurns],
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return {
        running: pipeline?.isRunning ?? false,
        framesSent: pipeline?.framesSent ?? 0,
        playbackFramesReceived: pipeline?.playbackFramesReceived ?? 0,
        lastEchoErleDb: pipeline?.lastEchoErleDb ?? 0,
        turnsObserved: pipeline?.turnsObserved ?? 0,
        abi,
        recentTurns: [...recentTurns],
      };
    },
    isRunning() {
      return pipeline?.isRunning ?? false;
    },
  };

  if (!installed && typeof window !== "undefined") {
    window.__jniVoice = control;
    installed = true;
  }
  return control;
}
