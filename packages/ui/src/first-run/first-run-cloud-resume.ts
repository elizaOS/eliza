/**
 * Cloud-login resume marker (device WebView-eviction survival).
 *
 * On a native device the first-run cloud login opens an EXTERNAL browser
 * (SFSafariViewController), which backgrounds the WebView; iOS frequently
 * cold-launches the app on return, wiping the conductor's in-memory flow state
 * (draftRef / pendingCloudResumeRef / the transcript). Without a durable marker
 * the conductor re-mounts and re-seeds the greeting — the user experiences a
 * "restart" back to "where should your agent run?".
 *
 * This marker persists the minimum needed to RESUME the interrupted cloud flow
 * after the relaunch: the runtime intent + the draft fields the provision step
 * reads. Paired with the durable cloud token (steward-session), on return the
 * conductor re-arms the existing auto-resume path and completes onboarding into
 * chat instead of restarting. Cleared on completion or a fresh runtime pick.
 */

import type { FirstRunLocalInference, FirstRunProfileDraft } from "./first-run";

const CLOUD_RESUME_STORAGE_KEY = "eliza:first-run:cloud-resume";

export interface CloudResumeMarker {
  /** Which runtime initiated the cloud login (drives the resume branch). */
  runtime: "cloud" | "hybrid";
  localInference: FirstRunLocalInference;
  agentName: string;
}

export function markCloudLoginPending(
  draft: Pick<FirstRunProfileDraft, "localInference" | "agentName"> & {
    runtime: "cloud" | "hybrid";
  },
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CLOUD_RESUME_STORAGE_KEY,
      JSON.stringify({
        runtime: draft.runtime,
        localInference: draft.localInference,
        agentName: draft.agentName,
      } satisfies CloudResumeMarker),
    );
  } catch {
    // error-policy:J6 storage unavailable → the flow still works in-session
    // (in-memory refs); it just won't survive a WebView eviction.
  }
}

export function readCloudLoginPending(): CloudResumeMarker | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CLOUD_RESUME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CloudResumeMarker>;
    if (parsed.runtime !== "cloud" && parsed.runtime !== "hybrid") return null;
    if (
      parsed.localInference !== "all-local" &&
      parsed.localInference !== "cloud-inference" &&
      parsed.localInference !== "configure-later"
    ) {
      return null;
    }
    return {
      runtime: parsed.runtime,
      localInference: parsed.localInference,
      agentName: typeof parsed.agentName === "string" ? parsed.agentName : "",
    };
  } catch {
    // error-policy:J3 corrupt persisted marker — treat as "no pending resume"
    // so a bad blob can't wedge first-run
    return null;
  }
}

export function clearCloudLoginPending(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CLOUD_RESUME_STORAGE_KEY);
  } catch {
    // error-policy:J6 best-effort cleanup — a storage that rejects removeItem
    // also rejected the setItem in markCloudLoginPending, so there is no
    // persisted marker to clear
  }
}

export const __TEST_ONLY__ = { CLOUD_RESUME_STORAGE_KEY };
