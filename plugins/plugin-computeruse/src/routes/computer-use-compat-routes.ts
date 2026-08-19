/**
 * Authenticated compatibility routes for computer-use approvals and approval
 * mode. The handlers resolve the service structurally from the active runtime
 * so the plugin bridge does not require a concrete runtime implementation.
 * Local-trust is fail-closed: a missing peer address, a proxy client-IP
 * header, a non-loopback Host, a present Origin that does not match Host
 * (including port), or browser fetch metadata other than same-origin/none
 * must not authorize approval routes.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { resolveAliasedEnvValue } from "@elizaos/core";
import { isTrustedComputerUseLocalRequest } from "./computer-use-compat-local-trust.ts";
import { decodePathComponent } from "./route-utils.js";

type CompatRuntimeState = {
  current: {
    getService?: (name: string) => unknown;
  } | null;
};

const MAX_BODY_BYTES = 1_048_576;

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

function tokenMatches(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  return (
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf)
  );
}

function getCompatApiToken(): string | null {
  return resolveAliasedEnvValue("ELIZA_API_TOKEN")?.trim() || null;
}

function getProvidedApiToken(
  req: Pick<http.IncomingMessage, "headers">,
): string | null {
  const authHeader = firstHeaderValue(req.headers.authorization)
    ?.slice(0, 1024)
    ?.trim();
  if (authHeader) {
    const match = /^Bearer\s{1,8}(.+)$/i.exec(authHeader);
    if (match?.[1]) return match[1].trim();
  }

  return (
    (
      firstHeaderValue(req.headers["x-eliza-token"]) ??
      firstHeaderValue(req.headers["x-elizaos-token"]) ??
      firstHeaderValue(req.headers["x-api-key"]) ??
      firstHeaderValue(req.headers["x-api-token"])
    )?.trim() || null
  );
}

function sendJsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendJsonErrorResponse(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  sendJsonResponse(res, status, { error: message });
}

function ensureCompatSensitiveRouteAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
): boolean {
  if (isTrustedComputerUseLocalRequest(req)) return true;

  const expected = getCompatApiToken();
  const provided = getProvidedApiToken(req);
  if (expected && provided && tokenMatches(expected, provided)) {
    return true;
  }

  sendJsonErrorResponse(res, expected ? 401 : 403, "Unauthorized");
  return false;
}

async function ensureRouteAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
  _state?: CompatRuntimeState,
): Promise<boolean> {
  if (isTrustedComputerUseLocalRequest(req)) return true;

  const expected = getCompatApiToken();
  const provided = getProvidedApiToken(req);
  if (expected && provided && tokenMatches(expected, provided)) {
    return true;
  }

  sendJsonErrorResponse(res, 401, "Unauthorized");
  return false;
}

async function readCompatJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | null> {
  const preParsed = (req as { body?: unknown }).body;
  if (preParsed && typeof preParsed === "object" && !Array.isArray(preParsed)) {
    return preParsed as Record<string, unknown>;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        sendJsonErrorResponse(res, 413, "Request body too large");
        return null;
      }
      chunks.push(buf);
    }
  } catch {
    // error-policy:J1 route boundary — a broken body stream becomes an
    // explicit 400; null tells the route handler the response is already
    // sent.
    sendJsonErrorResponse(res, 400, "Invalid request body");
    return null;
  }

  if (chunks.length === 0) return {};

  try {
    const parsed = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJsonErrorResponse(res, 400, "Invalid JSON body");
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    // error-policy:J3 untrusted request body; unparseable JSON becomes an
    // explicit 400 — never an empty-object fake-valid body.
    sendJsonErrorResponse(res, 400, "Invalid JSON body");
    return null;
  }
}

type ComputerUseApprovalMode =
  | "full_control"
  | "smart_approve"
  | "approve_all"
  | "off";

type ComputerUseApprovalSnapshot = {
  mode: ComputerUseApprovalMode;
  pendingCount: number;
  pendingApprovals: Array<{
    id: string;
    command: string;
    parameters: Record<string, unknown>;
    requestedAt: string;
  }>;
};

type ComputerUseApprovalResolution = {
  id: string;
  command: string;
  approved: boolean;
  cancelled: boolean;
  mode: ComputerUseApprovalMode;
  requestedAt: string;
  resolvedAt: string;
  reason?: string;
};

type ComputerUseServiceLike = {
  getApprovalSnapshot(): ComputerUseApprovalSnapshot;
  setApprovalMode(mode: ComputerUseApprovalMode): ComputerUseApprovalMode;
  resolveApproval(
    id: string,
    approved: boolean,
    reason?: string,
  ): ComputerUseApprovalResolution | null;
  subscribeApprovals?(
    listener: (snapshot: ComputerUseApprovalSnapshot) => void,
  ): () => void;
};

const VALID_APPROVAL_MODES: ComputerUseApprovalMode[] = [
  "full_control",
  "smart_approve",
  "approve_all",
  "off",
];

const EMPTY_APPROVAL_SNAPSHOT: ComputerUseApprovalSnapshot = {
  mode: "full_control",
  pendingCount: 0,
  pendingApprovals: [],
};

function isApprovalMode(value: string): value is ComputerUseApprovalMode {
  return VALID_APPROVAL_MODES.includes(value as ComputerUseApprovalMode);
}

function getComputerUseService(
  state: CompatRuntimeState,
): ComputerUseServiceLike | null {
  const runtime = state.current as {
    getService?: (name: string) => unknown;
  } | null;
  if (!runtime?.getService) {
    return null;
  }

  const service = runtime.getService("computeruse");
  if (!service || typeof service !== "object") {
    return null;
  }

  const candidate = service as Partial<ComputerUseServiceLike>;
  if (
    typeof candidate.getApprovalSnapshot !== "function" ||
    typeof candidate.setApprovalMode !== "function" ||
    typeof candidate.resolveApproval !== "function"
  ) {
    return null;
  }

  return candidate as ComputerUseServiceLike;
}

function isStreamAuthorized(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): boolean {
  const expectedToken = getCompatApiToken();
  if (!expectedToken) {
    return true;
  }

  const headerToken = getProvidedApiToken(req);
  const providedToken = url.searchParams.get("token")?.trim();
  if (
    (headerToken && tokenMatches(expectedToken, headerToken)) ||
    (providedToken && tokenMatches(expectedToken, providedToken))
  ) {
    return true;
  }

  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
  return false;
}

function writeSseEvent(
  res: http.ServerResponse,
  payload: Record<string, unknown>,
): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function handleComputerUseCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!url.pathname.startsWith("/api/computer-use/")) {
    return false;
  }

  if (
    method === "GET" &&
    url.pathname === "/api/computer-use/approvals/stream"
  ) {
    if (!isStreamAuthorized(req, res, url)) {
      return true;
    }

    const service = getComputerUseService(state);
    if (!service) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      writeSseEvent(res, {
        type: "snapshot",
        snapshot: EMPTY_APPROVAL_SNAPSHOT,
      });
      res.end();
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    writeSseEvent(res, {
      type: "snapshot",
      snapshot: service.getApprovalSnapshot(),
    });

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15_000);
    if (typeof heartbeat === "object" && "unref" in heartbeat) {
      heartbeat.unref();
    }

    const unsubscribe = service.subscribeApprovals?.((snapshot) => {
      writeSseEvent(res, {
        type: "snapshot",
        snapshot,
      });
    });

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    };

    req.on("close", cleanup);
    req.on("aborted", cleanup);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/computer-use/approvals") {
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }

    const service = getComputerUseService(state);
    if (!service) {
      sendJsonResponse(res, 200, EMPTY_APPROVAL_SNAPSHOT);
      return true;
    }

    sendJsonResponse(res, 200, service.getApprovalSnapshot());
    return true;
  }

  if (method === "POST" && url.pathname === "/api/computer-use/approval-mode") {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) {
      return true;
    }

    const body = await readCompatJsonBody(req, res);
    if (!body) {
      return true;
    }

    if (typeof body.mode !== "string" || !isApprovalMode(body.mode)) {
      sendJsonErrorResponse(
        res,
        400,
        "mode must be one of full_control, smart_approve, approve_all, off",
      );
      return true;
    }

    const service = getComputerUseService(state);
    if (!service) {
      sendJsonErrorResponse(res, 404, "Computer use service not available");
      return true;
    }

    sendJsonResponse(res, 200, {
      mode: service.setApprovalMode(body.mode),
    });
    return true;
  }

  const match = url.pathname.match(/^\/api\/computer-use\/approvals\/([^/]+)$/);
  if (method === "POST" && match) {
    if (!ensureCompatSensitiveRouteAuthorized(req, res)) {
      return true;
    }

    const approvalId = match[1];
    if (approvalId === undefined) {
      sendJsonErrorResponse(res, 400, "Missing approval id");
      return true;
    }
    const decodedApprovalId = decodePathComponent(approvalId);
    if (decodedApprovalId === null) {
      sendJsonErrorResponse(
        res,
        400,
        "Invalid approval id: malformed URL encoding",
      );
      return true;
    }

    const body = await readCompatJsonBody(req, res);
    if (!body) {
      return true;
    }

    if (typeof body.approved !== "boolean") {
      sendJsonErrorResponse(res, 400, "approved must be a boolean");
      return true;
    }

    const service = getComputerUseService(state);
    if (!service) {
      sendJsonErrorResponse(res, 404, "Computer use service not available");
      return true;
    }

    const resolution = service.resolveApproval(
      decodedApprovalId,
      body.approved,
      typeof body.reason === "string" ? body.reason : undefined,
    );

    if (!resolution) {
      sendJsonErrorResponse(res, 404, "Approval not found");
      return true;
    }

    sendJsonResponse(res, 200, resolution);
    return true;
  }

  sendJsonErrorResponse(res, 404, "Not found");
  return true;
}

/**
 * Runtime plugin route adapter. The runtime plugin route bridge passes
 * `(req, res, runtime)` — wrap into a CompatRuntimeState adapter for the
 * shared dispatcher.
 */
export function computerUseRouteHandler() {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const state = { current: runtime } as CompatRuntimeState;
    await handleComputerUseCompatRoutes(httpReq, httpRes, state);
  };
}
