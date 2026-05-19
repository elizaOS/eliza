/**
 * LifeOps-specific window events.
 *
 * Dispatched on `window` for cross-frame visibility and local diagnostics.
 */

import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/shared";

export const LIFEOPS_GOOGLE_CONNECTOR_REFRESH_EVENT =
  "eliza:lifeops-google-connector-refresh" as const;

export const LIFEOPS_GITHUB_CALLBACK_EVENT =
  "eliza:lifeops-github-callback" as const;

export const LIFEOPS_ACTIVITY_SIGNALS_STATUS_EVENT =
  "eliza:lifeops-activity-signals-status" as const;

export interface LifeOpsGoogleConnectorRefreshDetail {
  origin?: string;
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  source?:
    | "callback"
    | "connect"
    | "disconnect"
    | "mode_change"
    | "refresh"
    | "focus"
    | "visibility"
    | "resume";
}

export interface LifeOpsGithubCallbackDetail {
  target: "owner" | "agent";
  status: "connected" | "error";
  connectionId?: string | null;
  agentId?: string | null;
  githubUsername?: string | null;
  bindingMode?: "cloud-managed" | "shared-owner" | null;
  message?: string | null;
  restarted?: boolean;
}

export interface LifeOpsActivitySignalsStatusDetail {
  status:
    | "capture_error"
    | "snapshot_unavailable"
    | "background_refresh_unavailable";
  message?: string;
  reason?: string;
}

export function dispatchLifeOpsGoogleConnectorRefresh(
  detail?: LifeOpsGoogleConnectorRefreshDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(LIFEOPS_GOOGLE_CONNECTOR_REFRESH_EVENT, { detail }),
  );
}

export function dispatchLifeOpsGithubCallback(
  detail: LifeOpsGithubCallbackDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(LIFEOPS_GITHUB_CALLBACK_EVENT, { detail }),
  );
}

export function dispatchLifeOpsActivitySignalsStatus(
  detail: LifeOpsActivitySignalsStatusDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(LIFEOPS_ACTIVITY_SIGNALS_STATUS_EVENT, { detail }),
  );
}
