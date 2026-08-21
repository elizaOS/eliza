/**
 * Pure policy math for the visible browser-session surface: resolves the
 * effective domain mode for a session against the bridge settings, decides
 * which scripted actions are intercepted pending user confirmation, computes
 * session TTL/expiry, and projects a session result into a credential-safe
 * receipt. Everything here is `(inputs) -> value` with an explicit `nowIso`
 * so renders stay deterministic; the panel component owns the clock.
 *
 * Domain matching fails closed: an unresolvable domain never matches a grant,
 * and a blocked origin wins over every allow mode.
 */
import type { BrowserBridgeSettings } from "../../api/browser-contracts";
import type {
  BrowserBridgeSession,
  BrowserBridgeSessionAction,
} from "../../api/client-browser-bridge";

/** Default retention window after which a finished session is prune-eligible. */
export const BROWSER_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type BrowserDomainPolicyMode =
  | "bridge_disabled"
  | "control_disabled"
  | "paused"
  | "blocked"
  | "all_sites"
  | "granted"
  | "current_site_only"
  | "outside_grants"
  | "unresolved";

export interface BrowserDomainPolicyVerdict {
  mode: BrowserDomainPolicyMode;
  /** Whether the agent may drive this domain under the current settings. */
  allowed: boolean;
}

/**
 * Normalizes an origin entry (`https://example.com/*`, `*.example.com`,
 * `example.com`) to a bare lowercase hostname, or null when unusable.
 */
export function normalizeOriginHost(origin: string): string | null {
  const trimmed = origin.trim().toLowerCase();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const hostPart = withoutScheme.split("/")[0] ?? "";
  const withoutPort = hostPart.split(":")[0] ?? "";
  const host = withoutPort.replace(/^\*\.?/, "").replace(/\.+$/, "");
  return host.length > 0 ? host : null;
}

/** True when `domain` equals the origin host or is a subdomain of it. */
export function domainMatchesOrigin(domain: string, origin: string): boolean {
  const host = normalizeOriginHost(origin);
  if (!host) return false;
  const normalizedDomain = domain.trim().toLowerCase().replace(/\.+$/, "");
  if (!normalizedDomain) return false;
  return normalizedDomain === host || normalizedDomain.endsWith(`.${host}`);
}

/**
 * Resolves the visible domain-mode verdict for one session domain against the
 * bridge settings. Ordering is deliberate: disabled bridge, disabled control,
 * and an active pause all pre-empt per-domain rules; a blocklist match then
 * beats every allow mode.
 */
export function resolveBrowserDomainPolicy(
  domain: string | null,
  settings: BrowserBridgeSettings,
  nowIso: string,
): BrowserDomainPolicyVerdict {
  if (!settings.enabled) {
    return { mode: "bridge_disabled", allowed: false };
  }
  if (!settings.allowBrowserControl) {
    return { mode: "control_disabled", allowed: false };
  }
  if (settings.pauseUntil) {
    const pauseUntilMs = Date.parse(settings.pauseUntil);
    const nowMs = Date.parse(nowIso);
    if (
      Number.isFinite(pauseUntilMs) &&
      Number.isFinite(nowMs) &&
      pauseUntilMs > nowMs
    ) {
      return { mode: "paused", allowed: false };
    }
  }
  const normalizedDomain = domain?.trim().toLowerCase() ?? "";
  if (!normalizedDomain) {
    return { mode: "unresolved", allowed: false };
  }
  if (
    settings.blockedOrigins.some((origin) =>
      domainMatchesOrigin(normalizedDomain, origin),
    )
  ) {
    return { mode: "blocked", allowed: false };
  }
  if (settings.siteAccessMode === "all_sites") {
    return { mode: "all_sites", allowed: true };
  }
  if (settings.siteAccessMode === "current_site_only") {
    return { mode: "current_site_only", allowed: true };
  }
  if (
    settings.grantedOrigins.some((origin) =>
      domainMatchesOrigin(normalizedDomain, origin),
    )
  ) {
    return { mode: "granted", allowed: true };
  }
  return { mode: "outside_grants", allowed: false };
}

/** True when the session is parked waiting for the user to take over. */
export function sessionRequiresTakeover(
  session: BrowserBridgeSession,
): boolean {
  return session.status === "awaiting_confirmation";
}

const SUBMIT_ACTION_KINDS = new Set(["submit"]);

/**
 * Actions the panel must surface as intercepted: explicit
 * `requiresConfirmation` steps, and — when the settings demand confirmation
 * for account-affecting work — every account-affecting or submit step.
 */
export function interceptedSessionActions(
  session: BrowserBridgeSession,
  settings: BrowserBridgeSettings,
): BrowserBridgeSessionAction[] {
  return session.actions.filter((action) => {
    if (action.requiresConfirmation) return true;
    if (!settings.requireConfirmationForAccountAffecting) return false;
    return action.accountAffecting || SUBMIT_ACTION_KINDS.has(action.kind);
  });
}

const FINISHED_SESSION_STATUSES = new Set(["done", "cancelled", "failed"]);

/** ISO timestamp at which the session leaves its retention window. */
export function browserSessionExpiresAt(
  session: BrowserBridgeSession,
  ttlMs: number = BROWSER_SESSION_TTL_MS,
): string | null {
  const anchor = session.finishedAt ?? session.updatedAt;
  const anchorMs = Date.parse(anchor);
  if (!Number.isFinite(anchorMs)) return null;
  return new Date(anchorMs + ttlMs).toISOString();
}

/** True when a finished session has aged past its TTL and may be pruned. */
export function isBrowserSessionExpired(
  session: BrowserBridgeSession,
  nowIso: string,
  ttlMs: number = BROWSER_SESSION_TTL_MS,
): boolean {
  if (!FINISHED_SESSION_STATUSES.has(session.status)) return false;
  const expiresAt = browserSessionExpiresAt(session, ttlMs);
  if (!expiresAt) return false;
  const nowMs = Date.parse(nowIso);
  return Number.isFinite(nowMs) && nowMs >= Date.parse(expiresAt);
}

const REDACTED_KEY_PATTERN =
  /token|secret|password|passwd|cookie|authorization|credential|api[-_]?key|session[-_]?id/i;

export interface BrowserSessionReceiptEntry {
  key: string;
  value: string;
  redacted: boolean;
}

const RECEIPT_VALUE_MAX_LENGTH = 200;
const RECEIPT_REDACTION_MAX_DEPTH = 8;

/**
 * Recursively replaces values under credential-looking keys anywhere inside a
 * nested result structure. Depth is bounded so a cyclic or absurdly deep
 * payload collapses to the redaction marker instead of recursing forever —
 * fail closed, never fail open.
 */
function redactNestedValue(value: unknown, depth: number): unknown {
  if (depth >= RECEIPT_REDACTION_MAX_DEPTH) return "[redacted]";
  if (Array.isArray(value)) {
    return value.map((entry) => redactNestedValue(entry, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) =>
        REDACTED_KEY_PATTERN.test(key)
          ? [key, "[redacted]"]
          : [key, redactNestedValue(nested, depth + 1)],
      ),
    );
  }
  return value;
}

function renderReceiptValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > RECEIPT_VALUE_MAX_LENGTH
      ? `${value.slice(0, RECEIPT_VALUE_MAX_LENGTH)}…`
      : value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  const serialized = JSON.stringify(redactNestedValue(value, 0)) ?? "";
  return serialized.length > RECEIPT_VALUE_MAX_LENGTH
    ? `${serialized.slice(0, RECEIPT_VALUE_MAX_LENGTH)}…`
    : serialized;
}

/**
 * Projects a session's result into displayable receipt entries. Keys that
 * look credential-bearing are redacted unconditionally — the receipt surface
 * must never leak tokens, cookies, or passwords even when an upstream service
 * put them in the result payload.
 */
export function summarizeBrowserSessionReceipt(
  session: BrowserBridgeSession,
): BrowserSessionReceiptEntry[] {
  return Object.entries(session.result).map(([key, value]) => {
    if (REDACTED_KEY_PATTERN.test(key)) {
      return { key, value: "[redacted]", redacted: true };
    }
    return { key, value: renderReceiptValue(value), redacted: false };
  });
}
