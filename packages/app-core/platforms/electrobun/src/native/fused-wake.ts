/**
 * Fused on-device wake-word native module for Electrobun (#10351).
 *
 * Runs the REAL standalone `libwakeword` (openWakeWord) detector in the desktop
 * Bun main process — where `bun:ffi` works, `DesktopMicSource` can spawn the OS
 * recorder, and {@link SendToWebview} reaches the renderer directly. On a fresh
 * trained-head fire it forwards the canonical `FusedWakeEventDetail` (built by
 * the shared {@link bridgeDetectorToFusedWake}: `{ stage:'head-fired',
 * confidence }`) to the renderer as `voice:fusedWake`, where the desktop
 * transport (`registerDesktopFusedWake`, packages/ui) forwards it to the
 * `eliza:fused-wake` bridge → `useWakeController` → the bottom bar.
 *
 * This is the production producer that turns the bridge on: the renderer
 * consumer + the shared `FUSED_WAKE_EVENT`/`emitFusedWake` contract landed via
 * #10373, but nothing ran the native head + forwarded it to the renderer. It
 * uses the standalone wakeword-cpp path (`resolveWakeWordStandalonePaths` +
 * `OpenWakeWordGgmlModel`), which needs no fused FFI handle — so it is fully
 * self-contained in the main process.
 *
 * Inert + safe by default:
 *   - `start()` resolves the prebuilt `libwakeword` + three `hey-eliza` GGUFs;
 *     when they are not staged it returns `{ started: false }` and never spawns
 *     the mic (no model → no detection, no surprise mic access).
 *   - the mic recorder can be overridden for deterministic capture via
 *     `ELIZA_FUSED_WAKE_MIC_PROGRAM` / `ELIZA_FUSED_WAKE_MIC_ARGV` (e.g. ffmpeg
 *     reading a known `hey-eliza` clip) — the on-device validation path.
 */

import {
  bridgeDetectorToFusedWake,
  DesktopMicSource,
  OpenWakeWordDetector,
  OpenWakeWordGgmlModel,
  type PcmFrame,
  resolveWakeWordStandalonePaths,
} from "@elizaos/plugin-local-inference/voice-wake";
import type { SendToWebview } from "../types.js";

const SAMPLE_RATE = 16_000;

interface FusedWakeStartParams {
  /** Wake-phrase head name. Default `hey-eliza`. */
  head?: string;
  /** P(wake) firing threshold (openWakeWord default ~0.5). */
  threshold?: number;
}

interface MicLike {
  onFrame(listener: (frame: PcmFrame) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ModelLike {
  readonly frameSamples: number;
  readonly sampleRate: number;
  scoreFrame(frame: Float32Array): Promise<number>;
  reset(): void;
  close(): void;
}

export class FusedWakeManager {
  private sendToWebview: SendToWebview | null = null;
  private model: ModelLike | null = null;
  private mic: MicLike | null = null;
  private unsubFrame: (() => void) | null = null;
  private listening = false;

  setSendToWebview(fn: SendToWebview): void {
    this.sendToWebview = fn;
  }

  async isListening(): Promise<{ listening: boolean }> {
    return { listening: this.listening };
  }

  async start(
    params?: FusedWakeStartParams,
  ): Promise<{ started: boolean; reason?: string }> {
    if (this.listening) return { started: true };

    const head = params?.head?.trim() || "hey-eliza";
    const paths = resolveWakeWordStandalonePaths({ head });
    if (!paths) {
      // libwakeword + the three GGUFs are not staged on this install — stay
      // inert (no mic) rather than fake a listen. The renderer keeps the
      // Swabble fallback.
      return { started: false, reason: "wakeword-model-not-staged" };
    }

    let model: ModelLike;
    try {
      model = await OpenWakeWordGgmlModel.load({
        libraryPath: paths.libraryPath,
        paths: {
          melspec: paths.melspec,
          embedding: paths.embedding,
          classifier: paths.classifier,
        },
        ...(params?.threshold !== undefined
          ? { config: { threshold: params.threshold } }
          : {}),
      });
    } catch (err) {
      return {
        started: false,
        reason: `wakeword-load-failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Map each real detector fire to the canonical FusedWakeEventDetail and
    // push it to the renderer. `bridgeDetectorToFusedWake` is the shared
    // (#10373) head-fired mapping — the producer side uses the same contract
    // the renderer consumes, so the two never drift.
    const detector = new OpenWakeWordDetector({
      model,
      ...(params?.threshold !== undefined
        ? { config: { threshold: params.threshold } }
        : {}),
      onWake: bridgeDetectorToFusedWake((event) => {
        // eslint-disable-next-line no-console
        console.log(
          `[FusedWakeManager] head fired (confidence=${event.confidence?.toFixed(3) ?? "?"}) → voice:fusedWake`,
        );
        this.sendToWebview?.("voice:fusedWake", event);
      }),
    });

    const mic = this.createMicSource();

    // Re-buffer arbitrary mic frames into exact `frameSamples` (1280 = 80 ms @
    // 16 kHz) frames the detector expects — mirrors engine.feedWakeFrame.
    const need = model.frameSamples;
    let acc = new Float32Array(0);
    this.unsubFrame = mic.onFrame((frame) => {
      const merged = new Float32Array(acc.length + frame.pcm.length);
      merged.set(acc);
      merged.set(frame.pcm, acc.length);
      let off = 0;
      while (merged.length - off >= need) {
        void detector.pushFrame(merged.slice(off, off + need));
        off += need;
      }
      acc = merged.slice(off);
    });

    try {
      await mic.start();
    } catch (err) {
      this.unsubFrame?.();
      this.unsubFrame = null;
      model.close();
      return {
        started: false,
        reason: `mic-start-failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    this.model = model;
    this.mic = mic;
    this.listening = true;
    // eslint-disable-next-line no-console
    console.log(
      `[FusedWakeManager] listening (head=${head}, backend=${(model as { activeBackend?: () => string }).activeBackend?.() ?? "native"})`,
    );
    this.sendToWebview?.("voice:fusedWakeState", { listening: true });
    return { started: true };
  }

  async stop(): Promise<void> {
    this.listening = false;
    this.unsubFrame?.();
    this.unsubFrame = null;
    try {
      await this.mic?.stop();
    } finally {
      this.mic = null;
      this.model?.close();
      this.model = null;
      this.sendToWebview?.("voice:fusedWakeState", { listening: false });
    }
  }

  dispose(): void {
    void this.stop();
    this.sendToWebview = null;
  }

  /**
   * Build the capture source. The default uses the OS recorder via
   * `DesktopMicSource`; an env override feeds a deterministic clip (the
   * on-device validation path) — e.g.
   *   ELIZA_FUSED_WAKE_MIC_PROGRAM=ffmpeg
   *   ELIZA_FUSED_WAKE_MIC_ARGV='-hide_banner|-loglevel|error|-re|-f|f32le|-ar|16000|-ac|1|-i|/path/hey-eliza.f32|-ar|16000|-ac|1|-f|s16le|-'
   */
  private createMicSource(): MicLike {
    const program = process.env.ELIZA_FUSED_WAKE_MIC_PROGRAM?.trim();
    const argvRaw = process.env.ELIZA_FUSED_WAKE_MIC_ARGV;
    if (program && argvRaw) {
      return new DesktopMicSource({
        sampleRate: SAMPLE_RATE,
        program,
        argv: argvRaw.split("|"),
      }) as MicLike;
    }
    return new DesktopMicSource({
      sampleRate: SAMPLE_RATE,
    }) as MicLike;
  }
}

let fusedWakeManager: FusedWakeManager | null = null;

export function getFusedWakeManager(): FusedWakeManager {
  if (!fusedWakeManager) {
    fusedWakeManager = new FusedWakeManager();
  }
  return fusedWakeManager;
}
