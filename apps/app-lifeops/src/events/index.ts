/**
 * LifeOps-specific window events.
 *
 * Dispatched on `window` for cross-frame visibility (Google connector refresh,
 * GitHub OAuth callback routing).
 */

import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/shared/contracts/lifeops";

export const LIFEOPS_GOOGLE_CONNECTOR_REFRESH_EVENT =
  "eliza:lifeops-google-connector-refresh" as const;

export const LIFEOPS_GITHUB_CALLBACK_EVENT =
  "eliza:lifeops-github-callback" as const;

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
