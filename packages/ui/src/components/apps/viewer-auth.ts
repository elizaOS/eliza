/**
 * Pure resolvers for embedding a running app's viewer in an iframe: turns a
 * viewer URL into an absolute origin, derives the postMessage target origin and
 * `*_READY` handshake event type from the auth message, builds a per-run viewer
 * session key, decides whether a run should use the embedded viewer path, and
 * validates server-supplied iframe `sandbox` token sets
 * ({@link sanitizeGameViewerSandbox}). Shared by `EmbeddedAppViewer`,
 * `GameViewOverlay`, and `FullscreenView` so the origin-pinning rules that keep
 * the auth token from leaking are defined once.
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
 * The MDN iframe `sandbox` token vocabulary — the only tokens a
 * server-supplied viewer sandbox string may keep. Anything else is dropped so
 * a control-plane value cannot invent capabilities the attribute parser would
 * ignore anyway, keeping the rendered token set explicit and reviewable.
 */
const SANDBOX_TOKEN_ALLOWLIST: ReadonlySet<string> = new Set([
  "allow-downloads",
  "allow-forms",
  "allow-modals",
  "allow-orientation-lock",
  "allow-pointer-lock",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-presentation",
  "allow-same-origin",
  "allow-scripts",
  "allow-storage-access-by-user-activation",
  "allow-top-navigation",
  "allow-top-navigation-by-user-activation",
  "allow-top-navigation-to-custom-protocols",
]);

const ALLOW_SCRIPTS = "allow-scripts";
const ALLOW_SAME_ORIGIN = "allow-same-origin";

/** Sandbox applied when a run's viewer config carries no sandbox string. */
export const DEFAULT_GAME_VIEWER_SANDBOX =
  "allow-scripts allow-same-origin allow-popups";

/**
 * Whether the resolved viewer URL is same-origin with the shell. Fails closed:
 * an unparseable/relative-without-window URL is treated as same-origin so the
 * dangerous token combination is stripped whenever origin cannot be proven
 * distinct.
 */
function isViewerSameOriginWithShell(resolvedViewerUrl: string): boolean {
  try {
    const shellOrigin = window.location.origin;
    const parsed = resolvedViewerUrl.startsWith("/")
      ? new URL(resolvedViewerUrl, shellOrigin)
      : new URL(resolvedViewerUrl);
    return parsed.origin === shellOrigin;
  } catch {
    // error-policy:J3 unverifiable viewer origin fails closed to same-origin,
    // which strips allow-same-origin below.
    return true;
  }
}

/**
 * Validate a server-supplied viewer `sandbox` attribute before it reaches an
 * iframe. Tokens are filtered to {@link SANDBOX_TOKEN_ALLOWLIST}; when the
 * viewer URL resolves same-origin with the shell, `allow-same-origin` is
 * stripped whenever `allow-scripts` is present — that pairing on same-origin
 * content lets the framed document rewrite its own sandbox attribute and
 * re-run with full host privilege (MDN), reaching host DOM, storage, and
 * native bridges. The combination is preserved for genuinely cross-origin
 * viewers, where the framed document stays on its own origin and the browser
 * same-origin policy keeps it out of the shell.
 */
export function sanitizeGameViewerSandbox(
  sandbox: string | null | undefined,
  viewerUrl: string,
): string {
  const tokens: string[] = [];
  for (const token of (sandbox ?? DEFAULT_GAME_VIEWER_SANDBOX).split(/\s+/)) {
    if (
      token.length > 0 &&
      SANDBOX_TOKEN_ALLOWLIST.has(token) &&
      !tokens.includes(token)
    ) {
      tokens.push(token);
    }
  }
  if (
    tokens.includes(ALLOW_SCRIPTS) &&
    tokens.includes(ALLOW_SAME_ORIGIN) &&
    isViewerSameOriginWithShell(resolveEmbeddedViewerUrl(viewerUrl))
  ) {
    return tokens.filter((token) => token !== ALLOW_SAME_ORIGIN).join(" ");
  }
  return tokens.join(" ");
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
    // error-policy:J3 unparseable viewer URL yields no trusted origin —
    // fail closed so no auth handshake is offered to it.
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
