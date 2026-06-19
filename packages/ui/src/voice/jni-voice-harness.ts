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
 * Install-once and inert off Android. It does not change product behavior; it
 * makes the in-process pipeline drivable + observable on a real device.
 */

import {
  getElizaVoicePlugin,
  getTalkModePlugin,
} from "../bridge/native-plugins";
import { type JniAttributedTurn, JniVoicePipeline } from "./jni-voice-pipeline";

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

const MAX_RECENT = 20;

let installed = false;
let pipeline: JniVoicePipeline | null = null;
const recentTurns: JniVoiceTurnSummary[] = [];

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

function getPipeline(): JniVoicePipeline {
  if (!pipeline) {
    pipeline = new JniVoicePipeline(getTalkModePlugin(), getElizaVoicePlugin());
    pipeline.onTurn(recordTurn);
  }
  return pipeline;
}

/**
 * Attach `window.__jniVoice`. Idempotent. Returns the control surface (also
 * usable directly from app code, not only CDP).
 */
export function installJniVoiceHarness(): JniVoiceControl {
  const control: JniVoiceControl = {
    async start() {
      return getPipeline().start();
    },
    async stop() {
      const p = getPipeline();
      const framesSent = p.framesSent;
      await p.stop();
      return { stopped: true, framesSent };
    },
    async status() {
      let abi: JniVoiceStatus["abi"];
      try {
        abi = await getElizaVoicePlugin().voiceAbiVersion();
      } catch (err) {
        return {
          running: pipeline?.isRunning ?? false,
          framesSent: pipeline?.framesSent ?? 0,
          turnsObserved: pipeline?.turnsObserved ?? 0,
          recentTurns: [...recentTurns],
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return {
        running: pipeline?.isRunning ?? false,
        framesSent: pipeline?.framesSent ?? 0,
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
    (window as unknown as { __jniVoice?: JniVoiceControl }).__jniVoice =
      control;
    installed = true;
  }
  return control;
}
