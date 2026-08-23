/** Claimed shell round-trip for owner-approved Devices & Runtimes operations. */

import { randomUUID } from "node:crypto";
import type http from "node:http";
import {
  isRuntimeManagementOperation,
  type RuntimeManagementRequest,
  type RuntimeManagementResult,
  readJsonBody,
} from "@elizaos/shared";
import { PendingRequestMap } from "./pending-request-map.ts";

const PREFIX = "/api/runtime/manage";
const SHELL_TIMEOUT_MS = 45_000;
const pending = new PendingRequestMap();
const claims = new Map<string, { token: string | null; expiresAt: number }>();

export interface RuntimeManagementRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  broadcastWs?: (payload: object) => void;
}

function boundedString(value: unknown, max = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

function boundedPort(value: unknown): number | undefined {
  return Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= 65535
    ? Number(value)
    : undefined;
}

function parseRequest(
  body: Record<string, unknown>,
): RuntimeManagementRequest | null {
  if (!isRuntimeManagementOperation(body.op)) return null;
  if (
    "accessToken" in body ||
    "privateKey" in body ||
    "password" in body ||
    "credential" in body
  ) {
    return null;
  }
  return {
    op: body.op,
    targetId: boundedString(body.targetId),
    runtimeId: boundedString(body.runtimeId),
    label: boundedString(body.label, 256),
    target: boundedString(body.target, 512),
    sshPort: boundedPort(body.sshPort),
    remoteApiPort: boundedPort(body.remoteApiPort),
    expectedFingerprint: boundedString(body.expectedFingerprint, 256),
    identityFile: boundedString(body.identityFile, 1024),
    apiBase: boundedString(body.apiBase, 2048),
    sessionId: boundedString(body.sessionId, 256),
    code: boundedString(body.code, 32),
  };
}

function purgeExpiredClaims(now = Date.now()): void {
  for (const [requestId, claim] of claims) {
    if (claim.expiresAt <= now) claims.delete(requestId);
  }
}

export async function handleRuntimeManagementRoutes(
  ctx: RuntimeManagementRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error } = ctx;
  if (!pathname.startsWith(PREFIX)) return false;
  purgeExpiredClaims();

  if (method === "POST" && pathname === PREFIX) {
    const body = await readJsonBody<Record<string, unknown>>(req, res).catch(
      () => null,
    );
    if (!body) return true;
    const request = parseRequest(body);
    if (!request) {
      error(res, "Invalid runtime operation or secret-bearing field.", 400);
      return true;
    }
    if (!ctx.broadcastWs) {
      json(res, { ok: false, op: request.op, error: "no-shell" });
      return true;
    }

    const requestId = randomUUID();
    claims.set(requestId, {
      token: null,
      expiresAt: Date.now() + SHELL_TIMEOUT_MS,
    });
    const outcome = pending.waitFor(requestId, SHELL_TIMEOUT_MS);
    ctx.broadcastWs({ type: "shell:manage-runtime", requestId, request });
    try {
      const resolved = await outcome;
      const detail =
        resolved.result &&
        typeof resolved.result === "object" &&
        !Array.isArray(resolved.result)
          ? (resolved.result as Record<string, unknown>)
          : {};
      const data =
        detail.data &&
        typeof detail.data === "object" &&
        !Array.isArray(detail.data)
          ? (detail.data as Record<string, unknown>)
          : undefined;
      json(res, {
        ok: resolved.success,
        op: request.op,
        ...(data ? { data } : {}),
        ...(typeof detail.error === "string" ? { error: detail.error } : {}),
      } satisfies RuntimeManagementResult);
    } catch {
      json(res, { ok: false, op: request.op, error: "no-shell" });
    } finally {
      claims.delete(requestId);
    }
    return true;
  }

  if (method === "POST" && pathname === `${PREFIX}/claim`) {
    const body = await readJsonBody<Record<string, unknown>>(req, res).catch(
      () => null,
    );
    if (!body) return true;
    const requestId = boundedString(body.requestId, 128);
    const claim = requestId ? claims.get(requestId) : undefined;
    if (!requestId || !claim || claim.expiresAt <= Date.now()) {
      json(res, { claimed: false });
      return true;
    }
    if (claim.token) {
      json(res, { claimed: false });
      return true;
    }
    claim.token = randomUUID();
    json(res, { claimed: true, claimToken: claim.token });
    return true;
  }

  if (method === "POST" && pathname === `${PREFIX}/result`) {
    const body = await readJsonBody<Record<string, unknown>>(req, res).catch(
      () => null,
    );
    if (!body) return true;
    const requestId = boundedString(body.requestId, 128);
    const claimToken = boundedString(body.claimToken, 128);
    const claim = requestId ? claims.get(requestId) : undefined;
    if (!requestId || !claimToken || claim?.token !== claimToken) {
      error(res, "Unknown or unclaimed runtime operation.", 409);
      return true;
    }
    const data =
      body.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? (body.data as Record<string, unknown>)
        : undefined;
    pending.resolve(requestId, {
      requestId,
      success: body.ok === true,
      result: {
        ...(data ? { data } : {}),
        ...(typeof body.error === "string"
          ? { error: body.error.slice(0, 512) }
          : {}),
      },
    });
    json(res, { accepted: true });
    return true;
  }

  error(res, "Runtime management route not found", 404);
  return true;
}

export const runtimeManagementRouteInternals = {
  claims,
  parseRequest,
  purgeExpiredClaims,
};
