import crypto from "node:crypto";
import type http from "node:http";
import { resolveWalletExportRejection as upstreamResolveWalletExportRejection } from "@elizaos/agent";
import { logger } from "@elizaos/core";
import type {
  WalletExportRejection as CompatWalletExportRejection,
  WalletExportRequestBody,
} from "@elizaos/shared";
import { syncAppEnvToEliza, syncElizaEnvAliases } from "@elizaos/shared";

type UpstreamRejectionFn = (
  req: http.IncomingMessage,
  body: WalletExportRequestBody,
) => CompatWalletExportRejection | null;

interface RateLimitEntry {
  lastExportAt: number;
}

interface HardenedExportRequestBody extends WalletExportRequestBody {
  exportNonce?: string;
  requestNonce?: boolean;
}

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const EXPORT_DELAY_MS = 10_000;
const MAX_PENDING_NONCES_PER_IP = 3;
const NONCE_TTL_MS = 5 * 60 * 1000;

const rateLimitMap = new Map<string, RateLimitEntry>();
const pendingExportNonces = new Map<string, { issuedAt: number; ip: string }>();

const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.lastExportAt > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(key);
    }
  }
}, RATE_LIMIT_SWEEP_INTERVAL_MS);

if (typeof sweepTimer === "object" && "unref" in sweepTimer) {
  sweepTimer.unref();
}

function normalizeCompatReason(reason: string): string {
  return reason;
}

function mirrorCompatHeaders(req: Pick<http.IncomingMessage, "headers">): void {
  const headerAliases = [
    ["x-elizaos-token", "x-eliza-token"],
    ["x-elizaos-export-token", "x-eliza-export-token"],
    ["x-elizaos-client-id", "x-eliza-client-id"],
    ["x-elizaos-terminal-token", "x-eliza-terminal-token"],
    ["x-elizaos-ui-language", "x-eliza-ui-language"],
    ["x-elizaos-agent-action", "x-eliza-agent-action"],
  ] as const;

  for (const [appHeader, elizaHeader] of headerAliases) {
    const appValue = req.headers[appHeader];
    const elizaValue = req.headers[elizaHeader];

    if (appValue != null && elizaValue == null) {
      req.headers[elizaHeader] = appValue;
    }

    if (elizaValue != null && appValue == null) {
      req.headers[appHeader] = elizaValue;
    }
  }
}

export function normalizeCompatRejection<
  T extends { status: number; reason: string } | null,
>(rejection: T): T {
  if (!rejection) {
    return rejection;
  }

  rejection.reason = normalizeCompatReason(rejection.reason);
  return rejection;
}

export function runWithCompatAuthContext<T>(
  req: Pick<http.IncomingMessage, "headers">,
  operation: () => T,
): T {
  syncElizaEnvAliases();
  syncAppEnvToEliza();
  mirrorCompatHeaders(req);

  try {
    return operation();
  } finally {
    syncAppEnvToEliza();
    syncElizaEnvAliases();
  }
}

function getClientIp(req: http.IncomingMessage): string | null {
  return req.socket?.remoteAddress ?? null;
}

function getUserAgent(req: http.IncomingMessage): string {
  const userAgent = req.headers["user-agent"];
  return typeof userAgent === "string" ? userAgent : "unknown";
}

function recordWalletExportAudit(entry: {
  ip: string;
  outcome: "allowed" | "rate-limited" | "rejected";
  reason?: string;
  timestamp: string;
  userAgent: string;
}): void {
  logger.warn(
    {
      src: "app-core:server-wallet-trade",
      ...entry,
    },
    "[server-wallet-trade] Wallet export audit",
  );
}

function issueExportNonce(ip: string): string | null {
  const now = Date.now();
  for (const [key, value] of pendingExportNonces) {
    if (now - value.issuedAt > NONCE_TTL_MS) {
      pendingExportNonces.delete(key);
    }
  }

  let countForIp = 0;
  for (const entry of pendingExportNonces.values()) {
    if (entry.ip === ip) {
      countForIp++;
    }
  }

  if (countForIp >= MAX_PENDING_NONCES_PER_IP) {
    return null;
  }

  const nonce = `wxn_${crypto.randomBytes(16).toString("hex")}`;
  pendingExportNonces.set(nonce, { issuedAt: now, ip });
  return nonce;
}

function validateExportNonce(
  nonce: string,
  ip: string,
): { valid: true } | { reason: string; valid: false } {
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

  pendingExportNonces.delete(nonce);
  return { valid: true };
}

function createHardenedExportGuard(
  upstream: UpstreamRejectionFn,
): (
  req: http.IncomingMessage,
  body: HardenedExportRequestBody,
) => CompatWalletExportRejection | null {
  return (
    req: http.IncomingMessage,
    body: HardenedExportRequestBody,
  ): CompatWalletExportRejection | null => {
    const ip = getClientIp(req);
    const userAgent = getUserAgent(req);

    if (!ip) {
      recordWalletExportAudit({
        timestamp: new Date().toISOString(),
        ip: "unknown",
        userAgent,
        outcome: "rejected",
        reason: "No client IP available on socket",
      });
      return {
        status: 400,
        reason: "Unable to determine client IP; request rejected.",
      };
    }

    const upstreamRejection = upstream(req, body);
    if (upstreamRejection) {
      recordWalletExportAudit({
        timestamp: new Date().toISOString(),
        ip,
        userAgent,
        outcome: "rejected",
        reason: upstreamRejection.reason,
      });
      return upstreamRejection;
    }

    if (body.requestNonce) {
      const nonce = issueExportNonce(ip);
      if (!nonce) {
        recordWalletExportAudit({
          timestamp: new Date().toISOString(),
          ip,
          userAgent,
          outcome: "rejected",
          reason: "Too many pending nonces for this IP",
        });
        return {
          status: 429,
          reason:
            "Too many pending export requests. Complete or wait for existing nonces to expire.",
        };
      }

      recordWalletExportAudit({
        timestamp: new Date().toISOString(),
        ip,
        userAgent,
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
      recordWalletExportAudit({
        timestamp: new Date().toISOString(),
        ip,
        userAgent,
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
    if (nonceResult.valid === false) {
      recordWalletExportAudit({
        timestamp: new Date().toISOString(),
        ip,
        userAgent,
        outcome: "rejected",
        reason: nonceResult.reason,
      });
      return { status: 403, reason: nonceResult.reason };
    }

    const rateLimitEntry = rateLimitMap.get(ip);
    if (rateLimitEntry) {
      const elapsed = Date.now() - rateLimitEntry.lastExportAt;
      if (elapsed < RATE_LIMIT_WINDOW_MS) {
        const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - elapsed) / 1000);
        recordWalletExportAudit({
          timestamp: new Date().toISOString(),
          ip,
          userAgent,
          outcome: "rate-limited",
          reason: `Rate limited, retry after ${retryAfter}s`,
        });
        return {
          status: 429,
          reason: `Rate limit exceeded. One export per ${RATE_LIMIT_WINDOW_MS / 60_000} minutes. Retry after ${retryAfter} seconds.`,
        };
      }
    }

    rateLimitMap.set(ip, { lastExportAt: Date.now() });
    recordWalletExportAudit({
      timestamp: new Date().toISOString(),
      ip,
      userAgent,
      outcome: "allowed",
    });

    return null;
  };
}

function resolveCompatWalletExportRejection(
  ...args: Parameters<typeof upstreamResolveWalletExportRejection>
): CompatWalletExportRejection | null {
  const [req] = args;
  return runWithCompatAuthContext(req, () =>
    normalizeCompatRejection(upstreamResolveWalletExportRejection(...args)),
  );
}

const hardenedGuard = createHardenedExportGuard(
  resolveCompatWalletExportRejection,
);

export function resolveWalletExportRejection(
  ...args: Parameters<typeof upstreamResolveWalletExportRejection>
): CompatWalletExportRejection | null {
  const [req] = args;
  return runWithCompatAuthContext(req, () =>
    normalizeCompatRejection(hardenedGuard(...args)),
  );
}
