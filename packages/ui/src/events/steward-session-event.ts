/** Publishes typed Steward session transitions without exposing credentials. */

export const STEWARD_SESSION_CHANGE_EVENT = "steward-session-change";

export interface StewardSessionChangeDetail {
  state: "present" | "cleared";
  sessionEpoch: number;
}

let sessionEpoch = 0;

export function dispatchStewardSessionChange(
  state: StewardSessionChangeDetail["state"],
): void {
  if (typeof window === "undefined") return;
  sessionEpoch += 1;
  window.dispatchEvent(
    new CustomEvent<StewardSessionChangeDetail>(STEWARD_SESSION_CHANGE_EVENT, {
      detail: { state, sessionEpoch },
    }),
  );
}
