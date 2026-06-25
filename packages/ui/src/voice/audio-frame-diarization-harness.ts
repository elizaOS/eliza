/**
 * On-device live-diarization verification harness.
 *
 * Wires the {@link AudioFramePump} to the real native TalkMode plugin and
 * exposes a tiny control surface on `window.__diarizationPump` so the live
 * frame → VAD → diarizer → attributed-turn round trip can be driven and read
 * on-device via CDP (the same way `plugin-native-talkmode`'s AUDIO_FRAMES.md
 * verified raw capture). It is install-once and inert off Android.
 *
 *   window.__diarizationPump.start()  → start native capture + pump batches
 *   window.__diarizationPump.status() → agent's LiveDiarizationStatus (lib
 *                                       load, GGUF presence, frame/turn counts,
 *                                       recent attributed turns)
 *   window.__diarizationPump.stop()   → stop capture + flush the tail
 *
 * This is the device-evidence read for the WebView → agent transport: it does
 * not change product behavior, it just makes the already-wired pipeline
 * drivable + observable on a real device.
 */

import { getTalkModePlugin } from "../bridge/native-plugins";
import { MOBILE_LOCAL_AGENT_API_BASE } from "../first-run/mobile-runtime-mode";
import { AudioFramePump } from "./audio-frame-pump";

declare global {
  interface Window {
    __diarizationPump?: DiarizationPumpControl;
  }
}

const STATUS_PATH = "/api/voice/audio-frames/status";

export interface DiarizationPumpControl {
  start(): Promise<{
    started: boolean;
    suspendedStt?: boolean;
    error?: string;
  }>;
  stop(): Promise<{ stopped: boolean; framesSent: number }>;
  status(): Promise<unknown>;
  isRunning(): boolean;
}

let installed = false;
let pump: AudioFramePump | null = null;

function getPump(): AudioFramePump {
  if (!pump) pump = new AudioFramePump(getTalkModePlugin());
  return pump;
}

async function fetchStatus(): Promise<unknown> {
  const res = await fetch(`${MOBILE_LOCAL_AGENT_API_BASE}${STATUS_PATH}`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  return res.json();
}

/**
 * Attach `window.__diarizationPump`. Idempotent. Returns the control surface
 * (also usable directly from app code, not only CDP).
 */
export function installDiarizationPumpHarness(): DiarizationPumpControl {
  const control: DiarizationPumpControl = {
    async start() {
      return getPump().start();
    },
    async stop() {
      const p = getPump();
      const framesSent = p.framesSent;
      await p.stop();
      return { stopped: true, framesSent };
    },
    status: fetchStatus,
    isRunning() {
      return pump?.isRunning ?? false;
    },
  };

  if (!installed && typeof window !== "undefined") {
    window.__diarizationPump = control;
    installed = true;
  }
  return control;
}
