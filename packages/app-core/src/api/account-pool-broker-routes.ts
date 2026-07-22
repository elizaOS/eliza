/**
 * HTTP mount for the internal account-pool broker. This surface is intentionally
 * absent unless explicitly enabled by env and is only valid for loopback peers
 * presenting the broker bearer secret; the public chat/message routes never
 * pass through this handler.
 */
import crypto from "node:crypto";
import type http from "node:http";
import type { AccountPoolBrokerSnapshot } from "@elizaos/core";
import { isLoopbackRemoteAddress } from "@elizaos/shared";
import {
  AccountPoolBroker,
  parseBrokerLeaseRequest,
  parseBrokerReleaseRequest,
  parseBrokerReportRequest,
} from "../services/account-pool-broker.js";
import {
  createAccountPoolConsumerKey,
  listAccountPoolConsumerKeys,
  queryAccountPoolConsumerUsage,
  rotateAccountPoolConsumerKey,
  updateAccountPoolConsumerKey,
} from "../services/account-pool-consumer-metering.js";
import { readCompatJsonBody } from "./compat-route-shared.js";
import { sendJson } from "./response.js";

const ROUTE_PREFIX = "/internal/account-pool/v1";
const MIN_BROKER_SECRET_LENGTH = 32;

let brokerSingleton: AccountPoolBroker | null = null;

export function __resetAccountPoolBrokerRoutesForTests(): void {
  brokerSingleton = null;
}

function brokerEnabled(): boolean {
  const enabled =
    process.env.ELIZA_ACCOUNT_POOL_BROKER_ENABLED?.trim().toLowerCase();
  if (
    enabled !== "1" &&
    enabled !== "true" &&
    enabled !== "yes" &&
    enabled !== "on"
  ) {
    return false;
  }
  return brokerSecret() !== null;
}

function brokerSecret(): string | null {
  const secret = process.env.ELIZA_ACCOUNT_POOL_BROKER_SECRET?.trim();
  return secret && secret.length >= MIN_BROKER_SECRET_LENGTH ? secret : null;
}

function readBearer(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string") return null;
  if (!raw.toLowerCase().startsWith("bearer ")) return null;
  return raw.slice(7).trim();
}

// Compare fixed-length SHA-256 digests so neither content nor secret length
// leaks through timing.
function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(a).digest(),
    crypto.createHash("sha256").update(b).digest(),
  );
}

function broker(): AccountPoolBroker {
  brokerSingleton ??= new AccountPoolBroker();
  return brokerSingleton;
}

export function getAccountPoolBrokerSnapshot(): AccountPoolBrokerSnapshot {
  return brokerSingleton?.snapshot() ?? { accounts: {}, providers: {} };
}

function sendBrokerJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, status, body);
}

function methodAllowed(
  method: string,
  expected: "GET" | "POST" | "PATCH",
  res: http.ServerResponse,
): boolean {
  if (method === expected) return true;
  sendBrokerJson(res, 405, { ok: false, error: "method_not_allowed" });
  return false;
}

function parseOptionalMs(value: string | null): number | undefined | null {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function decodeRouteSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // error-policy:J3 route path segments are untrusted input; malformed
    // percent-encoding is an invalid request, not an internal route failure.
    return null;
  }
}

export async function handleAccountPoolBrokerRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(ROUTE_PREFIX)) return false;
  if (!brokerEnabled()) return false;

  res.setHeader("Cache-Control", "no-store");

  if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
    sendBrokerJson(res, 403, { ok: false, error: "loopback_only" });
    return true;
  }

  const expected = brokerSecret();
  const presented = readBearer(req);
  if (!expected || !presented || !safeEqual(presented, expected)) {
    sendBrokerJson(res, 401, { ok: false, error: "unauthorized" });
    return true;
  }

  if (url.pathname === `${ROUTE_PREFIX}/health`) {
    if (!methodAllowed(method, "GET", res)) return true;
    sendBrokerJson(res, 200, broker().health());
    return true;
  }

  if (url.pathname === `${ROUTE_PREFIX}/lease`) {
    if (!methodAllowed(method, "POST", res)) return true;
    const body = await readCompatJsonBody(req, res);
    if (body === null) return true;
    const parsed = parseBrokerLeaseRequest(body);
    if (!parsed) {
      sendBrokerJson(res, 400, { ok: false, error: "invalid_lease_request" });
      return true;
    }
    try {
      const lease = await broker().lease(parsed);
      if (!lease) {
        sendBrokerJson(res, 503, { ok: false, error: "no_account_available" });
        return true;
      }
      sendBrokerJson(res, 200, lease);
    } catch {
      // error-policy:J1 HTTP boundary translation: token resolution failures
      // become a structured unavailable response without exposing secrets.
      sendBrokerJson(res, 503, { ok: false, error: "token_unavailable" });
    }
    return true;
  }

  if (url.pathname === `${ROUTE_PREFIX}/report`) {
    if (!methodAllowed(method, "POST", res)) return true;
    const body = await readCompatJsonBody(req, res);
    if (body === null) return true;
    const parsed = parseBrokerReportRequest(body);
    if (!parsed) {
      sendBrokerJson(res, 400, { ok: false, error: "invalid_report_request" });
      return true;
    }
    const result = await broker().report(parsed);
    sendBrokerJson(res, result.ok ? 200 : 404, result);
    return true;
  }

  if (url.pathname === `${ROUTE_PREFIX}/release`) {
    if (!methodAllowed(method, "POST", res)) return true;
    const body = await readCompatJsonBody(req, res);
    if (body === null) return true;
    const parsed = parseBrokerReleaseRequest(body);
    if (!parsed) {
      sendBrokerJson(res, 400, { ok: false, error: "invalid_release_request" });
      return true;
    }
    sendBrokerJson(res, 200, broker().release(parsed));
    return true;
  }

  if (url.pathname === `${ROUTE_PREFIX}/consumer-keys`) {
    if (method === "GET") {
      sendBrokerJson(res, 200, {
        ok: true,
        keys: listAccountPoolConsumerKeys(),
      });
      return true;
    }
    if (!methodAllowed(method, "POST", res)) return true;
    const body = await readCompatJsonBody(req, res);
    if (body === null) return true;
    const created = createAccountPoolConsumerKey(body);
    if (!created) {
      sendBrokerJson(res, 400, {
        ok: false,
        error: "invalid_consumer_key_request",
      });
      return true;
    }
    sendBrokerJson(res, 201, { ok: true, ...created });
    return true;
  }

  const consumerKeyMatch = url.pathname.match(
    new RegExp(`^${ROUTE_PREFIX}/consumer-keys/([^/]+)(/rotate)?$`),
  );
  if (consumerKeyMatch) {
    const id = decodeRouteSegment(consumerKeyMatch[1] ?? "");
    if (id === null) {
      sendBrokerJson(res, 400, {
        ok: false,
        error: "invalid_consumer_key_id",
      });
      return true;
    }
    if (consumerKeyMatch[2] === "/rotate") {
      if (!methodAllowed(method, "POST", res)) return true;
      const rotated = rotateAccountPoolConsumerKey(id);
      if (!rotated) {
        sendBrokerJson(res, 404, {
          ok: false,
          error: "consumer_key_not_found",
        });
        return true;
      }
      sendBrokerJson(res, 200, { ok: true, ...rotated });
      return true;
    }
    if (!methodAllowed(method, "PATCH", res)) return true;
    const body = await readCompatJsonBody(req, res);
    if (body === null) return true;
    const updated = updateAccountPoolConsumerKey(id, body);
    if (updated === "invalid") {
      sendBrokerJson(res, 400, {
        ok: false,
        error: "invalid_consumer_key_request",
      });
      return true;
    }
    if (!updated) {
      sendBrokerJson(res, 404, { ok: false, error: "consumer_key_not_found" });
      return true;
    }
    sendBrokerJson(res, 200, { ok: true, consumer: updated });
    return true;
  }

  if (url.pathname === `${ROUTE_PREFIX}/usage`) {
    if (!methodAllowed(method, "GET", res)) return true;
    const startMs = parseOptionalMs(url.searchParams.get("startMs"));
    const endMs = parseOptionalMs(url.searchParams.get("endMs"));
    if (startMs === null || endMs === null) {
      sendBrokerJson(res, 400, { ok: false, error: "invalid_usage_query" });
      return true;
    }
    const usage = await queryAccountPoolConsumerUsage({
      ...(url.searchParams.get("consumerId")
        ? { consumerId: url.searchParams.get("consumerId") ?? undefined }
        : {}),
      ...(startMs !== undefined ? { startMs } : {}),
      ...(endMs !== undefined ? { endMs } : {}),
    });
    sendBrokerJson(res, 200, { ok: true, usage });
    return true;
  }

  sendBrokerJson(res, 404, { ok: false, error: "not_found" });
  return true;
}
