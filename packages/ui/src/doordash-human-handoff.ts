/** Routes validated DoorDash Live View or provider-blocked native handoffs into the app Browser. */

import type { ChatActionResultSummary } from "./api";
import { dispatchNavigateViewRequest } from "./events";

const LIVE_VIEW_HOST = "live.browser.run";

export interface DoorDashHumanHandoff {
  readonly liveViewUrl: string;
  readonly viewPath: string;
}

function safeLiveViewUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === LIVE_VIEW_HOST
      ? parsed.href
      : null;
  } catch {
    // error-policy:J3 untrusted action output is non-routable when malformed.
    return null;
  }
}

function safeNativeDoorDashDeepLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const deepLink = new URL(value);
    if (deepLink.protocol !== "elizaos:" || deepLink.hostname !== "browser") {
      return null;
    }
    const browse = deepLink.searchParams.get("browse");
    if (!browse) return null;
    const target = new URL(browse);
    return target.protocol === "https:" &&
      target.hostname === "www.doordash.com"
      ? target.href
      : null;
  } catch {
    // error-policy:J3 untrusted action output is non-routable when malformed.
    return null;
  }
}

export function findDoorDashHumanHandoff(
  results: readonly ChatActionResultSummary[] | undefined,
): DoorDashHumanHandoff | null {
  for (const result of results ?? []) {
    const values = result.values;
    if (
      !result.success ||
      result.actionName !== "DOORDASH" ||
      values?.provider !== "doordash" ||
      values.humanInterventionRequired !== true ||
      values.humanInterventionKind !== "cloudflare-browser-run"
    ) {
      continue;
    }
    const liveViewUrl = safeLiveViewUrl(values.liveViewUrl);
    if (!liveViewUrl) continue;
    const browserUrl =
      values.providerBlocked === true
        ? (safeNativeDoorDashDeepLink(values.nativeAppDeepLink) ?? liveViewUrl)
        : liveViewUrl;
    return {
      liveViewUrl,
      viewPath: `/browser?browse=${encodeURIComponent(browserUrl)}`,
    };
  }
  return null;
}

export function dispatchDoorDashHumanHandoff(
  results: readonly ChatActionResultSummary[] | undefined,
): boolean {
  const handoff = findDoorDashHumanHandoff(results);
  if (!handoff) return false;
  void dispatchNavigateViewRequest({
    viewId: "browser",
    viewPath: handoff.viewPath,
  });
  return true;
}
