/**
 * Hardened wallet private key export guard.
 *
 * Wraps the upstream resolveWalletExportRejection with:
 *   1. Per-IP rate limiting (1 successful export per 10 minutes)
 *   2. Audit logging with IP, User-Agent, and timestamp
 *   3. Forced confirmation delay (10s countdown)
 *
 * The upstream function validates the export token. This module adds
 * defence-in-depth so a compromised session cannot instantly extract
 * keys without leaving an audit trail and hitting rate limits.
 *
 * Canonical home: `@elizaos/plugin-wallet/lib/wallet-export-guard`. The
 * legacy path `@elizaos/app-core/api/wallet-export-guard` is a re-export
 * shim and will be removed once external consumers migrate.
 */

import crypto from "node:crypto";
import type http from "node:http";
import type {
  WalletExportRejection,
  WalletExportRequestBody,
} from "../contracts.js";

export type { WalletExportRejection };

type UpstreamRejectionFn = (
  req: http.IncomingMessage,
  body: WalletExportRequestBody,
) => WalletExportRejection | null;

// ── Rate limiter state ───────────────────────────────────────────────────────

interface RateLimitEntry {
  lastExportAt: number;
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // sweep stale entries

const rateLimitMap = new Map<string, RateLimitEntry>();

// Periodic sweep to prevent unbounded memory growth
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.lastExportAt > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(key);
    }
  }
}, RATE_LIMIT_SWEEP_INTERVAL_MS);

// Allow the process to exit without this timer holding it
if (typeof sweepTimer === "object" && "unref" in sweepTimer) {
  sweepTimer.unref();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get client IP from the socket directly. X-Forwarded-For is not trusted
 * because this is a local server — trusting XFF would let attackers spoof
 * IPs to bypass rate limits and nonce IP binding.
 */
function getClientIp(req: http.IncomingMessage): string | null {
  return req.socket?.remoteAddress ?? null;
}

function getUserAgent(req: http.IncomingMessage): string {
  return (req.headers["user-agent"] as string) ?? "unknown";
}

// ── Audit log ────────────────────────────────────────────────────────────────

export interface WalletExportAuditEntry {
  timestamp: string;
  ip: string;
  userAgent: string;
  outcome: "allowed" | "rate-limited" | "rejected";
  reason?: string;
}

// Keep last 100 entries in memory for diagnostics; also write to logger
const auditLog: WalletExportAuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 100;

function recordAudit(entry: WalletExportAuditEntry): void {
  auditLog.push(entry);
  if (auditLog.length > MAX_AUDIT_ENTRIES) {
    auditLog.shift();
  }

  const logLine = `[wallet-export-audit] ${entry.outcome} ip=${entry.ip} ua="${entry.userAgent}"${entry.reason ? ` reason="${entry.reason}"` : ""}`;
  console.warn(logLine);
}

/** Read-only snapshot of the audit log for diagnostics endpoints. */
export function getWalletExportAuditLog(): ReadonlyArray<WalletExportAuditEntry> {
  return [...auditLog];
}

/** Reset all internal state (rate limits, nonces, audit log). Test-only. */
export function _resetForTesting(): void {
  if (process.env.NODE_ENV === "production") return;
  rateLimitMap.clear();
  pendingExportNonces.clear();
  auditLog.length = 0;
}

// ── Confirmation delay ───────────────────────────────────────────────────────

const EXPORT_DELAY_MS = 10_000; // 10 seconds
const MAX_PENDING_NONCES_PER_IP = 3;

/**
 * Issue a time-limited export nonce.  The client must wait at least
 * EXPORT_DELAY_MS before submitting the actual export request with this nonce.
 */
const pendingExportNonces = new Map<string, { issuedAt: number; ip: string }>();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function issueExportNonce(ip: string): string | null {
  // Sweep expired nonces
  const now = Date.now();
  for (const [key, value] of pendingExportNonces) {
    if (now - value.issuedAt > NONCE_TTL_MS) {
      pendingExportNonces.delete(key);
    }
  }

  // Cap pending nonces per IP to prevent unbounded growth from repeated
  // requestNonce calls (which are rate-limit-exempt).
  let countForIp = 0;
  for (const entry of pendingExportNonces.values()) {
    if (entry.ip === ip) countForIp++;
  }
  if (countForIp >= MAX_PENDING_NONCES_PER_IP) {
    return null;
  }

  const nonce = `wxn_${crypto.randomBytes(16).toString("hex")}`;
  pendingExportNonces.set(nonce, { issuedAt: Date.now(), ip });

  return nonce;
}

function validateExportNonce(
  nonce: string,
  ip: string,
): { valid: true } | { valid: false; reason: string } {
  const entry = pendingExportNonces.get(nonce);
  if (!entry) {
    return { valid: false, reason: "Invalid or expired export nonce." };
  }

  if (entry.ip !== ip) {
    return {
      valid: false,
      reason: "Export nonce was issued to a different client.",
    };
  }

  const elapsed = Date.now() - entry.issuedAt;
  if (elapsed < EXPORT_DELAY_MS) {
    const remaining = Math.ceil((EXPORT_DELAY_MS - elapsed) / 1000);
    return {
      valid: false,
      reason: `Export confirmation delay not met. Wait ${remaining} more seconds.`,
    };
  }

  // Nonce consumed — delete it
  pendingExportNonces.delete(nonce);
  return { valid: true };
}

// ── Extended request body (adds nonce field) ─────────────────────────────────

interface HardenedExportRequestBody extends WalletExportRequestBody {
  exportNonce?: string;
  /** Client sends requestNonce: true to start the countdown flow. */
  requestNonce?: boolean;
}

// ── Main guard ───────────────────────────────────────────────────────────────

/**
 * Create a hardened wallet export rejection function that wraps the upstream
 * token validation with rate limiting, audit logging, and a forced delay.
 *
 * Two-phase export flow:
 *   1. POST /api/wallet/export  { confirm: true, exportToken: "...", requestNonce: true }
 *      → 403 with { nonce, delaySeconds } — client must wait
 *   2. POST /api/wallet/export  { confirm: true, exportToken: "...", exportNonce: "wxn_..." }
 *      → 200 with keys (if delay elapsed and rate limit not hit)
 */
export function createHardenedExportGuard(
  upstream: UpstreamRejectionFn,
): (
  req: http.IncomingMessage,
  body: HardenedExportRequestBody,
) => WalletExportRejection | null {
  return (
    req: http.IncomingMessage,
    body: HardenedExportRequestBody,
  ): WalletExportRejection | null => {
    const ip = getClientIp(req);
    const ua = getUserAgent(req);

    // Reject requests with no identifiable client IP — without an IP,
    // rate-limit and nonce-binding keys collapse, letting unrelated
    // requests share a single bucket.
    if (!ip) {
      recordAudit({
        timestamp: new Date().toISOString(),
        ip: "unknown",
        userAgent: ua,
        outcome: "rejected",
        reason: "No client IP available on socket",
      });
      return {
        status: 400,
        reason: "Unable to determine client IP; request rejected.",
      };
    }

    // 1. Run upstream validation first (token check, confirm flag)
    const upstreamRejection = upstream(req, body);
    if (upstreamRejection) {
      recordAudit({
        timestamp: new Date().toISOString(),
        ip,
        userAgent: ua,
        outcome: "rejected",
        reason: upstreamRejection.reason,
      });
      return upstreamRejection;
    }

    // 2. Nonce/delay flow — nonce requests are always allowed (no rate limit)
    if (body.requestNonce) {
      const nonce = issueExportNonce(ip);
      if (!nonce) {
        recordAudit({
          timestamp: new Date().toISOString(),
          ip,
          userAgent: ua,
          outcome: "rejected",
          reason: "Too many pending nonces for this IP",
        });
        return {
          status: 429,
          reason: `Too many pending export requests. Complete or wait for existing nonces to expire.`,
        };
      }
      recordAudit({
        timestamp: new Date().toISOString(),
        ip,
        userAgent: ua,
        outcome: "rejected",
        reason: "Nonce issued, waiting for confirmation delay",
      });
      return {
        status: 403,
        reason: JSON.stringify({
          countdown: true,
          nonce,
          delaySeconds: EXPORT_DELAY_MS / 1000,
          message: `Export nonce issued. Wait ${EXPORT_DELAY_MS / 1000} seconds, then re-submit with exportNonce: "${nonce}".`,
        }),
      };
    }

    if (!body.exportNonce) {
      recordAudit({
        timestamp: new Date().toISOString(),
        ip,
        userAgent: ua,
        outcome: "rejected",
        reason: "Missing export nonce",
      });
      return {
        status: 403,
        reason:
          'Export requires a confirmation delay. First send { "confirm": true, "exportToken": "...", "requestNonce": true } to start the countdown.',
      };
    }

    const nonceResult = validateExportNonce(body.exportNonce, ip);
    if (!nonceResult.valid) {
      recordAudit({
        timestamp: new Date().toISOString(),
        ip,
        userAgent: ua,
        outcome: "rejected",
        reason: nonceResult.reason,
      });
      return { status: 403, reason: nonceResult.reason };
    }

    // 3. Rate limit check (after nonce validation, before key export)
    const rateLimitEntry = rateLimitMap.get(ip);
    if (rateLimitEntry) {
      const elapsed = Date.now() - rateLimitEntry.lastExportAt;
      if (elapsed < RATE_LIMIT_WINDOW_MS) {
        const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - elapsed) / 1000);
        recordAudit({
          timestamp: new Date().toISOString(),
          ip,
          userAgent: ua,
          outcome: "rate-limited",
          reason: `Rate limited, retry after ${retryAfter}s`,
        });
        return {
          status: 429,
          reason: `Rate limit exceeded. One export per ${RATE_LIMIT_WINDOW_MS / 60_000} minutes. Retry after ${retryAfter} seconds.`,
        };
      }
    }

    // 4. All checks passed — record rate limit + audit
    rateLimitMap.set(ip, { lastExportAt: Date.now() });
    recordAudit({
      timestamp: new Date().toISOString(),
      ip,
      userAgent: ua,
      outcome: "allowed",
    });

    return null; // allow export
  };
}
