/**
 * Pure resolvers for embedding a running app's viewer in an iframe: turns a
 * viewer URL into an absolute origin, derives the postMessage target origin and
 * `*_READY` handshake event type from the auth message, builds a per-run viewer
 * session key, and decides whether a run should use the embedded viewer path.
 * Shared by `EmbeddedAppViewer`, `GameViewOverlay`, and `FullscreenView` so the
 * origin-pinning rules that keep the auth token from leaking are defined once.
 */

import type {
  AppRunSummary,
  AppViewerAuthMessage,
} from "../../api/client-types-cloud";
import { resolveApiUrl } from "../../utils";

function normalizeEmbedFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function resolveEmbeddedViewerUrl(viewerUrl: string): string {
  const normalized = viewerUrl.trim();
  if (!normalized) {
    return normalized;
  }
  if (normalized.startsWith("/api/")) {
    return resolveApiUrl(normalized);
  }
  return normalized;
}

/**
 * Resolve the concrete http(s) origin to use as the postMessage targetOrigin
 * for a viewer iframe. Returns `null` when the viewer URL does not resolve to a
 * concrete http(s) origin (non-http(s) scheme, opaque "null" origin, or
 * unparseable URL). Callers MUST treat `null` as "do not send" and refuse
 * inbound messages: an auth payload carries session/agent tokens, so it must
 * never be broadcast with a wildcard targetOrigin, and an unverifiable sender
 * origin must never be trusted (fail closed).
 */
export function resolvePostMessageTargetOrigin(
  viewerUrl: string,
): string | null {
  const resolvedViewerUrl = resolveEmbeddedViewerUrl(viewerUrl);
  try {
    const parsed = resolvedViewerUrl.startsWith("/")
      ? new URL(resolvedViewerUrl, window.location.origin)
      : new URL(resolvedViewerUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin === "null" ? null : parsed.origin;
  } catch {
    return null;
  }
}

export function resolveViewerReadyEventType(
  payload: AppViewerAuthMessage | null | undefined,
): string | null {
  if (!payload?.type) {
    return null;
  }

  const normalizedType = payload.type.trim();
  if (normalizedType.length === 0) {
    return null;
  }
  return normalizedType.replace(/_AUTH$/i, "_READY");
}

export function buildViewerSessionKey(
  viewerUrl: string,
  payload: AppViewerAuthMessage | null | undefined,
): string {
  return `${resolveEmbeddedViewerUrl(viewerUrl)}::${JSON.stringify(payload ?? null)}`;
}

export function shouldUseEmbeddedAppViewer(
  run: AppRunSummary | null | undefined,
): boolean {
  const viewer = run?.viewer;
  if (!viewer?.url) {
    return false;
  }

  if (viewer.postMessageAuth) {
    return true;
  }

  if (normalizeEmbedFlag(viewer.embedParams?.embedded)) {
    return true;
  }

  return typeof viewer.embedParams?.surface === "string";
}
