/**
 * Host ports for camera surfaces. A host decides where an explicit capture goes (for example its
 * own owned-media store, a document scan review or a question to its agent); the shared camera
 * view only previews a capture until the owner chooses one of the host's actions. Nothing is kept,
 * uploaded or handed off implicitly. The lock-screen secure camera stays a system surface and is
 * not served through these ports.
 */
import type { PhotoResult } from "./definitions";

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
  /** Other explicit hand-offs of the reviewed capture (for example scan review or a question). */
  actions?: readonly CameraCaptureAction[];
  /**
   * Reads the camera grant without prompting. When present, a preview stopped on a denial
   * restarts on return to the app only after access was granted in system settings.
   */
  checkAccess?: () => Promise<{ camera?: string }>;
}

/** A fresh operation identity for one capture's Keep. */
export function captureOperationId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Runs the host's Keep port. A thrown port or a malformed answer is an unknown outcome, never a
 * claimed save; the caller keeps the same operation identity for a retry.
 */
export async function keepCapture(
  keep: NonNullable<CameraHostPorts["keep"]>,
  photo: PhotoResult,
  operationId: string,
): Promise<CameraKeepOutcome> {
  try {
    const outcome = await keep.run(photo, operationId);
    if (outcome?.status === "saved") return outcome;
    if (outcome?.status === "failed" || outcome?.status === "unknown")
      return {
        status: outcome.status,
        message:
          typeof outcome.message === "string" && outcome.message
            ? outcome.message
            : "The photo was not kept.",
      };
  } catch {
    // Fall through: the store's answer was lost.
  }
  return {
    status: "unknown",
    message:
      "Keeping this photo could not be confirmed. Check the library before trying again.",
  };
}
