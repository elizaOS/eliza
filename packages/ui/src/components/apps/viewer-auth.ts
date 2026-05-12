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

export function resolvePostMessageTargetOrigin(viewerUrl: string): string {
  const resolvedViewerUrl = resolveEmbeddedViewerUrl(viewerUrl);
  try {
    const parsed = resolvedViewerUrl.startsWith("/")
      ? new URL(resolvedViewerUrl, window.location.origin)
      : new URL(resolvedViewerUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "*";
    }
    return parsed.origin === "null" ? "*" : parsed.origin;
  } catch {
    return "*";
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
