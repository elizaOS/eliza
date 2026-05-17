/**
 * Hardened export guard for `/api/wallet/export`.
 *
 * Wraps upstream `resolveWalletExportRejection` with:
 * 1. 10-second mandatory confirmation delay (two-phase nonce flow).
 * 2. 1-per-10-minute rate limit per IP on successful exports.
 * 3. Audit log entry (IP, User-Agent, timestamp) for every attempt.
 * 4. IP-bound, single-use nonces to prevent replay from different clients.
 */

import crypto from "node:crypto";

export interface ExportGuardRejection {
  status: number;
  reason: string;
}

export interface NonceResult {
  nonce: string;
  expiresAt: number;
}

export interface AuditRecord {
  ip: string;
  userAgent: string;
  timestamp: number;
  action: string;
  success: boolean;
}

const NONCE_DELAY_MS = 10_000;
const NONCE_TTL_MS = 60_000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_EXPORTS = 1;
const NONCE_MAP_SWEEP_THRESHOLD = 200;

interface PendingNonce {
  ip: string;
  createdAt: number;
  readyAt: number;
  expiresAt: number;
  consumed: boolean;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface HardenedExportGuard {
  requestNonce(ip: string): NonceResult;
  validateNonce(nonce: string, ip: string): ExportGuardRejection | null;
  checkRateLimit(ip: string): ExportGuardRejection | null;
  recordSuccessfulExport(ip: string): void;
  recordAudit(record: AuditRecord): void;
  getAuditLog(): readonly AuditRecord[];
}

export function createHardenedExportGuard(): HardenedExportGuard {
  const nonces = new Map<string, PendingNonce>();
  const rateLimits = new Map<string, RateLimitEntry>();
  const auditLog: AuditRecord[] = [];

  function sweepExpiredNonces(now: number): void {
    if (nonces.size <= NONCE_MAP_SWEEP_THRESHOLD) return;
    for (const [key, entry] of nonces) {
      if (now > entry.expiresAt || entry.consumed) {
        nonces.delete(key);
      }
    }
  }

  function sweepExpiredRateLimits(now: number): void {
    if (rateLimits.size <= NONCE_MAP_SWEEP_THRESHOLD) return;
    for (const [key, entry] of rateLimits) {
      if (now > entry.resetAt) {
        rateLimits.delete(key);
      }
    }
  }

  function requestNonce(ip: string): NonceResult {
    const now = Date.now();
    sweepExpiredNonces(now);

    const nonce = crypto.randomBytes(32).toString("hex");
    const entry: PendingNonce = {
      ip,
      createdAt: now,
      readyAt: now + NONCE_DELAY_MS,
      expiresAt: now + NONCE_TTL_MS,
      consumed: false,
    };
    nonces.set(nonce, entry);

    return { nonce, expiresAt: entry.expiresAt };
  }

  function validateNonce(
    nonce: string,
    ip: string,
  ): ExportGuardRejection | null {
    const entry = nonces.get(nonce);
    const now = Date.now();

    if (!entry) {
      return { status: 403, reason: "Invalid or expired nonce." };
    }

    if (entry.consumed) {
      return { status: 403, reason: "Nonce has already been used." };
    }

    if (entry.ip !== ip) {
      return {
        status: 403,
        reason: "Nonce was issued for a different client.",
      };
    }

    if (now > entry.expiresAt) {
      nonces.delete(nonce);
      return { status: 403, reason: "Invalid or expired nonce." };
    }

    if (now < entry.readyAt) {
      const remainingSec = Math.ceil((entry.readyAt - now) / 1000);
      return {
        status: 429,
        reason: `Confirmation delay not elapsed. Wait ${remainingSec} more second(s).`,
      };
    }

    entry.consumed = true;
    return null;
  }

  function checkRateLimit(ip: string): ExportGuardRejection | null {
    const now = Date.now();
    sweepExpiredRateLimits(now);

    const entry = rateLimits.get(ip);
    if (!entry || now > entry.resetAt) {
      return null;
    }

    if (entry.count >= RATE_LIMIT_MAX_EXPORTS) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      return {
        status: 429,
        reason: `Rate limit exceeded. Try again in ${retryAfterSec} second(s).`,
      };
    }

    return null;
  }

  function recordSuccessfulExport(ip: string): void {
    const now = Date.now();
    const entry = rateLimits.get(ip);

    if (!entry || now > entry.resetAt) {
      rateLimits.set(ip, {
        count: 1,
        resetAt: now + RATE_LIMIT_WINDOW_MS,
      });
    } else {
      entry.count += 1;
    }
  }

  function recordAudit(record: AuditRecord): void {
    auditLog.push(record);
    if (auditLog.length > 5000) {
      auditLog.splice(0, auditLog.length - 2500);
    }
  }

  function getAuditLog(): readonly AuditRecord[] {
    return auditLog;
  }

  return {
    requestNonce,
    validateNonce,
    checkRateLimit,
    recordSuccessfulExport,
    recordAudit,
    getAuditLog,
  };
}
