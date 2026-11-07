/**
 * One camera preview/capture/recording session for a host surface. It owns the lifecycle rules
 * every camera surface needs and nothing about presentation:
 *
 * - every start/stop bumps an epoch, so an answer that arrives after the surface closed, hid or
 *   restarted never moves the session (or the host) forward;
 * - stops are chained, so a new preview never races the previous one's release;
 * - a stopped or hidden surface finishes an active recording instead of abandoning it;
 * - at most one capture, control change or recording start runs at a time;
 * - a recording is only reported saved when the bridge returned a non-empty receipt and the
 *   host accepted it; the host decides where it lives (its own owned-media store) and how a
 *   receipt is identified.
 *
 * Denials are classified only from explicit permission errors (`cameraAccessDenied`). A start is
 * never retried automatically after an error: the host offers retry, and resume recovery goes
 * through `restartAfterResume` with `rearm()`. The secure lock-screen camera is a system surface
 * and is not served by this session.
 */
import type { CameraPreviewOptions, VideoCaptureOptions } from "./definitions";
import { type CameraAccessKind, cameraAccessDenied } from "./host-ports";

export type CameraSessionPhase = "off" | "starting" | "ready" | "error";

/** The receipt fields the session checks; hosts may carry more. */
export interface CameraRecordingReceipt {
  path: string;
  duration: number;
  fileSize: number;
}

/** The bridge subset the session drives. Option shapes are the host's wire subset. */
export interface CameraSessionBridge<
  Preview = CameraPreviewOptions,
  Recording = VideoCaptureOptions,
  Video extends CameraRecordingReceipt = CameraRecordingReceipt,
> {
  startPreview(options: Preview): Promise<unknown>;
  stopPreview(): Promise<unknown>;
  startRecording(options: Recording): Promise<unknown>;
  stopRecording(): Promise<Video>;
}

export interface CameraSessionHooks<Video> {
  /** A recording stopped and its receipt is being finalized. */
  recordingFinishing?(): void;
  /**
   * Adopt a complete recording receipt (for example read it back from the host's own media
   * store). Throwing reports the recording as failed; nothing is claimed saved.
   */
  recordingSaved?(video: Video): Promise<void> | void;
  /** The recording could not be confirmed. */
  recordingFailed?(): void;
  /** Any session state changed; hosts re-render from `snapshot()`. */
  changed?(): void;
}

export interface CameraSessionOptions<
  Preview,
  Recording,
  Video extends CameraRecordingReceipt,
> {
  camera: CameraSessionBridge<Preview, Recording, Video>;
  /** Whether the host surface is open, visible and owns the camera. */
  active(): boolean;
  /** Whether a camera bridge exists in this build. Defaults to available. */
  available?(): boolean;
  /** Preview options for the next start (direction, resolution, mirroring). */
  preview(): Preview;
  /** Recording options for the next recording (audio, limits, destination). */
  recording(): Recording;
  hooks?: CameraSessionHooks<Video>;
}

export type CameraStartOutcome =
  | { status: "ready" }
  /** Camera permission was explicitly denied; offer settings recovery. */
  | { status: "denied" }
  /** No bridge in this build, or the preview failed for another reason; offer retry. */
  | { status: "unavailable"; reason: "missing" | "failed"; error?: unknown }
  /** Not attempted: already starting/ready, recording, or stopped on an error without retry. */
  | { status: "skipped" }
  /** The surface closed or restarted while starting; the host must not react. */
  | { status: "stale" };

export type CameraControlOutcome = "done" | "failed" | "skipped" | "stale";

export type CameraRecordingStart =
  | "recording"
  /** Microphone permission was explicitly denied. */
  | "denied"
  | "failed"
  | "skipped"
  | "stale";

export type CameraRecordingOutcome = "saved" | "failed";

export type CameraExclusive<T> =
  | { status: "done"; value: T }
  /** Another capture, control change or recording is in progress. */
  | { status: "busy" };

export interface CameraSessionSnapshot {
  phase: CameraSessionPhase;
  denied?: CameraAccessKind;
  controlBusy: boolean;
  capturing: boolean;
  recording: boolean;
  recordingStarting: boolean;
  finalizing: boolean;
}

export interface CameraSession {
  readonly phase: CameraSessionPhase;
  readonly denied: CameraAccessKind | undefined;
  readonly recording: boolean;
  readonly recordingStarting: boolean;
  readonly finalizing: boolean;
  readonly capturing: boolean;
  readonly controlBusy: boolean;
  /** Any capture, control change or recording is in progress. */
  readonly busy: boolean;
  snapshot(): CameraSessionSnapshot;
  /** The current epoch; pair with `current(token)` for host work that spans awaits. */
  token(): number;
  /** Whether `token` is still the current epoch and the surface is still active. */
  current(token: number): boolean;
  start(retry?: boolean): Promise<CameraStartOutcome>;
  /** Release the preview; an active recording is finished (and reported) first. */
  stop(): Promise<void>;
  /** One preview control change (zoom, flash, switch, focus) at a time, only while ready. */
  control(task: () => Promise<unknown>): Promise<CameraControlOutcome>;
  startRecording(): Promise<CameraRecordingStart>;
  /** Finish the active recording; concurrent calls share one finalization. With no recording it
   * reports "failed" without calling the bridge or the hooks. */
  finishRecording(): Promise<CameraRecordingOutcome>;
  /** Run one capture exclusively; it may start the preview itself. */
  exclusive<T>(
    task: (token: number) => Promise<T>,
  ): Promise<CameraExclusive<T>>;
  /** After a resume grant: let the next start run although the session stopped on an error. */
  rearm(): void;
  /** Forget a denial the host's recovery dismissed (for example a microphone notice). */
  clearDenied(kind?: CameraAccessKind): void;
}

/** A recording receipt the session may hand to a host: a path and real duration and size. */
export function completeRecording(
  video: unknown,
): video is CameraRecordingReceipt {
  const value = video as Partial<CameraRecordingReceipt> | null;
  return (
    !!value &&
    typeof value.path === "string" &&
    value.path.length > 0 &&
    typeof value.duration === "number" &&
    Number.isFinite(value.duration) &&
    value.duration > 0 &&
    typeof value.fileSize === "number" &&
    Number.isFinite(value.fileSize) &&
    value.fileSize > 0
  );
}

export function createCameraSession<
  Preview = CameraPreviewOptions,
  Recording = VideoCaptureOptions,
  Video extends CameraRecordingReceipt = CameraRecordingReceipt,
>(options: CameraSessionOptions<Preview, Recording, Video>): CameraSession {
  const { camera, hooks = {} } = options;
  const available = options.available ?? (() => true);
  let phase: CameraSessionPhase = "off";
  let denied: CameraAccessKind | undefined;
  let epoch = 0;
  let controlBusy = false;
  let capturing = false;
  let recording = false;
  let recordingStarting = false;
  let finalizing: Promise<CameraRecordingOutcome> | undefined;
  let stopping: Promise<void> = Promise.resolve();

  const changed = () => {
    try {
      hooks.changed?.();
    } catch {
      // A host render failure never corrupts session state.
    }
  };
  /** Presentation hooks never corrupt session state or reject a finalization. */
  const notify = (hook: (() => void) | undefined) => {
    try {
      hook?.();
    } catch {
      // Same rule as `changed`.
    }
  };
  const current = (token: number) => token === epoch && options.active();
  /** A start is in flight or a preview is up (read through a call: awaits change it). */
  const previewOwned = () => phase === "starting" || phase === "ready";
  const busy = () =>
    capturing || controlBusy || recording || recordingStarting || !!finalizing;

  function finishRecording(): Promise<CameraRecordingOutcome> {
    if (finalizing) return finalizing;
    // Nothing is recording: never ask the bridge to stop (and never report a failure) for a
    // recording this session did not start, for example a repeated stop tap.
    if (!recording) return Promise.resolve("failed");
    recording = false;
    const flight = (async (): Promise<CameraRecordingOutcome> => {
      notify(hooks.recordingFinishing);
      try {
        const receipt = await camera.stopRecording();
        if (!completeRecording(receipt))
          throw new Error("Incomplete recording");
        await hooks.recordingSaved?.(receipt);
        return "saved";
      } catch {
        notify(hooks.recordingFailed);
        return "failed";
      } finally {
        finalizing = undefined;
        changed();
      }
    })();
    finalizing = flight;
    changed();
    return flight;
  }

  async function stop(): Promise<void> {
    ++epoch;
    phase = "off";
    controlBusy = false;
    changed();
    if (recording || finalizing) await finishRecording();
    await release();
  }

  /** Chain one preview release after any earlier release. */
  function release(): Promise<void> {
    stopping = stopping.then(async () => {
      try {
        if (available()) await camera.stopPreview();
      } catch {
        // A later start resets native state before previewing again.
      }
    });
    return stopping;
  }

  async function start(retry = false): Promise<CameraStartOutcome> {
    if (
      recordingStarting ||
      finalizing ||
      !options.active() ||
      phase === "starting" ||
      phase === "ready" ||
      (phase === "error" && !retry)
    )
      return { status: "skipped" };
    if (!available()) {
      phase = "error";
      changed();
      return { status: "unavailable", reason: "missing" };
    }
    const token = ++epoch;
    phase = "starting";
    changed();
    try {
      await stopping;
      if (!current(token)) {
        // The surface hid before the preview was requested; nothing to release.
        if (token === epoch) {
          phase = "off";
          changed();
        }
        return { status: "stale" };
      }
      await camera.startPreview(options.preview());
      if (!current(token)) {
        // The preview came up after the surface closed or hid. Release it unless a newer start
        // owns the camera now; that start replaces the preview itself.
        if (token === epoch) {
          phase = "off";
          changed();
        }
        if (!previewOwned()) void release();
        return { status: "stale" };
      }
      phase = "ready";
      if (denied === "camera") denied = undefined;
      changed();
      return { status: "ready" };
    } catch (error) {
      if (token !== epoch) return { status: "stale" };
      phase = "error";
      const kind = cameraAccessDenied(error);
      denied = kind === "camera" ? "camera" : undefined;
      changed();
      return kind === "camera"
        ? { status: "denied" }
        : { status: "unavailable", reason: "failed", error };
    }
  }

  async function control(
    task: () => Promise<unknown>,
  ): Promise<CameraControlOutcome> {
    if (phase !== "ready" || busy()) return "skipped";
    controlBusy = true;
    const token = epoch;
    changed();
    try {
      await task();
      return current(token) ? "done" : "stale";
    } catch {
      return token === epoch ? "failed" : "stale";
    } finally {
      if (token === epoch) controlBusy = false;
      changed();
    }
  }

  async function startRecording(): Promise<CameraRecordingStart> {
    if (phase !== "ready" || busy()) return "skipped";
    recordingStarting = true;
    const token = epoch;
    changed();
    try {
      await camera.startRecording(options.recording());
      recording = true;
      if (!current(token)) {
        recordingStarting = false;
        await finishRecording();
        return "stale";
      }
      return "recording";
    } catch (error) {
      if (!current(token)) return "stale";
      if (cameraAccessDenied(error) === "microphone") {
        denied = "microphone";
        return "denied";
      }
      return "failed";
    } finally {
      recordingStarting = false;
      changed();
    }
  }

  async function exclusive<T>(
    task: (token: number) => Promise<T>,
  ): Promise<CameraExclusive<T>> {
    if (busy()) return { status: "busy" };
    capturing = true;
    changed();
    try {
      return { status: "done", value: await task(epoch) };
    } finally {
      capturing = false;
      changed();
    }
  }

  return {
    get phase() {
      return phase;
    },
    get denied() {
      return denied;
    },
    get recording() {
      return recording;
    },
    get recordingStarting() {
      return recordingStarting;
    },
    get finalizing() {
      return !!finalizing;
    },
    get capturing() {
      return capturing;
    },
    get controlBusy() {
      return controlBusy;
    },
    get busy() {
      return busy();
    },
    snapshot: () => ({
      phase,
      denied,
      controlBusy,
      capturing,
      recording,
      recordingStarting,
      finalizing: !!finalizing,
    }),
    token: () => epoch,
    current,
    start,
    stop,
    control,
    startRecording,
    finishRecording,
    exclusive,
    rearm() {
      if (phase === "error") {
        phase = "off";
        changed();
      }
    },
    clearDenied(kind) {
      if (!kind || denied === kind) {
        denied = undefined;
        changed();
      }
    },
  };
}
