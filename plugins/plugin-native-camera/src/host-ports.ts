/**
 * Host ports for camera surfaces. A host decides where an explicit capture goes (for example its
 * own owned-media store, a document scan review or a question to its agent); the shared camera
 * view only previews a capture until the owner chooses one of the host's actions. Nothing is kept,
 * uploaded or handed off implicitly. The lock-screen secure camera stays a system surface and is
 * not served through these ports.
 */
import type {
  PhotoResult,
  VideoCaptureOptions,
  VideoResult,
} from "./definitions";

export type CameraAccessKind = "camera" | "microphone";

/**
 * Classifies an explicit permission denial only: the native bridge's denial codes, a browser
 * NotAllowedError/PermissionDeniedError or the bridge's own denial message. Every other failure is
 * left to the generic retry path; nothing is inferred from timing or from unrelated wording.
 */
export function cameraAccessDenied(
  error: unknown,
): CameraAccessKind | undefined {
  const value = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
  } | null;
  const code = typeof value?.code === "string" ? value.code : "";
  const name = typeof value?.name === "string" ? value.name : "";
  const message = typeof value?.message === "string" ? value.message : "";
  if (
    code === "MICROPHONE_DENIED" ||
    /microphone permission denied/i.test(message)
  )
    return "microphone";
  if (
    code === "CAMERA_PERMISSION_DENIED" ||
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    /camera permission denied/i.test(message)
  )
    return "camera";
  return undefined;
}

/** What a camera surface knows when the app returns to the foreground. */
export interface CameraResumeState {
  /** The access kind the preview stopped on, if it stopped on a denial. */
  denied?: string;
  phase: string;
  disposed: boolean;
}

/**
 * Whether a resume may restart a preview that stopped on a camera denial. Closing Android's own
 * permission dialog resumes the app too, so restarting on every resume would ask for the camera
 * again straight after "Don't allow". Only an actual grant (made in system settings) restarts the
 * preview; the read never prompts, an unreadable state restarts nothing, and a state that changed
 * while reading wins.
 */
export async function restartAfterResume(
  state: () => CameraResumeState,
  check: () => Promise<{ camera?: string }>,
): Promise<boolean> {
  const stopped = () => {
    const now = state();
    return now.denied === "camera" && now.phase === "error" && !now.disposed;
  };
  if (!stopped()) return false;
  let granted = false;
  try {
    granted = (await check()).camera === "granted";
  } catch {
    // Unknown access never restarts.
  }
  return granted && stopped();
}

/**
 * Outcome of an explicit Keep. Only a host receipt says "saved". "failed" means the store kept
 * nothing for that identity; "unknown" means it may have, so only the same identity may retry.
 */
export type CameraKeepOutcome =
  | { status: "saved"; id?: string; message?: string }
  | { status: "failed" | "unknown"; message: string };

/** One explicit hand-off of the reviewed capture, offered as a button. */
export interface CameraCaptureAction {
  id: string;
  label: string;
  run(photo: PhotoResult): Promise<void> | void;
}

export interface CameraHostPorts {
  /**
   * Storage port for an explicit Keep of the reviewed capture. The operation identity is stable
   * for one capture, so a retry after a lost or unknown answer resolves the same save instead of
   * keeping a duplicate. After a definite failure the next Keep gets a fresh identity, since the
   * store kept nothing and may keep answering "failed" for the old one.
   */
  keep?: {
    label: string;
    run(photo: PhotoResult, operationId: string): Promise<CameraKeepOutcome>;
  };
  /**
   * Video mode. Present only when the host can keep a recording; without it the surface offers
   * photos only. Same identity rules as `keep`.
   */
  video?: CameraVideoPort;
  /** Other explicit hand-offs of the reviewed capture (for example scan review or a question). */
  actions?: readonly CameraCaptureAction[];
  /**
   * Reads the camera grant without prompting. When present, a preview stopped on a denial
   * restarts on return to the app only after access was granted in system settings.
   */
  checkAccess?: () => Promise<{ camera?: string }>;
}

/**
 * Host port for recordings. A finished recording is only reviewed until the owner keeps it; the
 * host's storage port decides where a kept recording lives (for example its own owned-media
 * store). A recording the owner retakes, or one that finished after the surface closed, is handed
 * to `discard` so the host can release the bridge's file; nothing is kept implicitly.
 */
export interface CameraVideoPort {
  /** Recording options for the next recording (limits, audio). Defaults to the bridge's. */
  options?(): VideoCaptureOptions;
  keep: {
    label: string;
    run(video: VideoResult, operationId: string): Promise<CameraKeepOutcome>;
  };
  /** Release a recording that was not kept. Failures are the host's to report. */
  discard?(video: VideoResult): Promise<void> | void;
}

/** A fresh operation identity for one capture's Keep. */
export function captureOperationId(): string {
  return globalThis.crypto.randomUUID();
}

/** Runs one Keep port; a thrown port or malformed answer is unknown, never a claimed save. */
async function runKeep<T>(
  run: (item: T, operationId: string) => Promise<CameraKeepOutcome>,
  item: T,
  operationId: string,
  noun: "photo" | "video",
): Promise<CameraKeepOutcome> {
  try {
    const outcome = await run(item, operationId);
    if (outcome?.status === "saved") return outcome;
    if (outcome?.status === "failed" || outcome?.status === "unknown")
      return {
        status: outcome.status,
        message:
          typeof outcome.message === "string" && outcome.message
            ? outcome.message
            : `The ${noun} was not kept.`,
      };
  } catch {
    // Fall through: the store's answer was lost.
  }
  return {
    status: "unknown",
    message: `Keeping this ${noun} could not be confirmed. Check the library before trying again.`,
  };
}

/**
 * Runs the host's Keep port. A thrown port or a malformed answer is an unknown outcome, never a
 * claimed save; the caller keeps the same operation identity for a retry.
 */
export function keepCapture(
  keep: NonNullable<CameraHostPorts["keep"]>,
  photo: PhotoResult,
  operationId: string,
): Promise<CameraKeepOutcome> {
  return runKeep((item, id) => keep.run(item, id), photo, operationId, "photo");
}

/** Runs the host's video Keep port under the same rules as `keepCapture`. */
export function keepRecording(
  keep: CameraVideoPort["keep"],
  video: VideoResult,
  operationId: string,
): Promise<CameraKeepOutcome> {
  return runKeep((item, id) => keep.run(item, id), video, operationId, "video");
}
