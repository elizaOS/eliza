/**
 * HTTP mount for the internal account-pool broker. This surface is intentionally
 * absent unless explicitly enabled by env and is only valid for loopback peers
 * presenting the broker bearer secret; the public chat/message routes never
 * pass through this handler.
 */
import type http from "node:http";
import type { AccountPoolBrokerSnapshot } from "@elizaos/core";
import { isLoopbackRemoteAddress } from "@elizaos/shared";
import {
  AccountPoolBroker,
  parseBrokerLeaseRequest,
  parseBrokerReleaseRequest,
  parseBrokerReportRequest,
} from "../services/account-pool-broker.js";
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

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
  expected: "GET" | "POST",
  res: http.ServerResponse,
): boolean {
  if (method === expected) return true;
  sendBrokerJson(res, 405, { ok: false, error: "method_not_allowed" });
  return false;
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

  sendBrokerJson(res, 404, { ok: false, error: "not_found" });
  return true;
}
