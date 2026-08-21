/**
 * Authenticated compatibility routes for computer-use approvals and approval
 * mode. The handlers resolve the service structurally from the active runtime
 * so the plugin bridge does not require a concrete runtime implementation.
 * Local-trust is fail-closed: a missing peer address, a proxy client-IP
 * header, a non-loopback Host, or a cross-site fetch metadata mark must not
 * authorize approval routes.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { resolveAliasedEnvValue } from "@elizaos/core";
import { ComputerUseSessionError } from "../sessions/session-manager.js";
import type {
  ComputerUseSessionAction,
  ComputerUseSessionEvent,
  ComputerUseSessionSnapshot,
  CreateComputerUseSessionInput,
} from "../sessions/types.js";
import { isTrustedComputerUseLocalRequest } from "./computer-use-compat-local-trust.js";
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

type ComputerUseSessionServiceLike = {
  createSession(
    input: CreateComputerUseSessionInput,
  ): ComputerUseSessionSnapshot;
  listSessions(): ComputerUseSessionSnapshot[];
  getSession(id: string): ComputerUseSessionSnapshot | null;
  closeSession(id: string): ComputerUseSessionSnapshot;
  renewSessionLease(
    id: string,
    leaseTtlMs?: number,
  ): ComputerUseSessionSnapshot;
  executeSessionAction(
    id: string,
    action: ComputerUseSessionAction,
  ): Promise<{ session: ComputerUseSessionSnapshot; result: unknown }>;
  captureSessionFrame(id: string): Promise<unknown>;
  getSessionEvents(afterEventId?: number): ComputerUseSessionEvent[];
  subscribeSessions(
    listener: (event: ComputerUseSessionEvent) => void,
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

function getComputerUseSessionService(
  state: CompatRuntimeState,
): ComputerUseSessionServiceLike | null {
  const runtime = state.current;
  if (!runtime?.getService) return null;
  const service = runtime.getService("computeruse");
  if (!service || typeof service !== "object") return null;
  const candidate = service as Partial<ComputerUseSessionServiceLike>;
  if (
    typeof candidate.createSession !== "function" ||
    typeof candidate.listSessions !== "function" ||
    typeof candidate.getSession !== "function" ||
    typeof candidate.closeSession !== "function" ||
    typeof candidate.renewSessionLease !== "function" ||
    typeof candidate.executeSessionAction !== "function" ||
    typeof candidate.captureSessionFrame !== "function" ||
    typeof candidate.getSessionEvents !== "function" ||
    typeof candidate.subscribeSessions !== "function"
  ) {
    return null;
  }
  return candidate as ComputerUseSessionServiceLike;
}

function sessionErrorStatus(error: ComputerUseSessionError): number {
  switch (error.code) {
    case "INVALID_SESSION_INPUT":
      return 400;
    case "SESSION_NOT_FOUND":
      return 404;
    case "SESSION_CLOSED":
    case "SESSION_BUSY":
    case "HOST_LEASE_CONFLICT":
    case "TARGET_LEASE_CONFLICT":
    case "HOST_LEASE_EXPIRED":
    case "STALE_SESSION_SEQUENCE":
    case "DUPLICATE_ACTION_ID":
      return 409;
  }
}

function sendSessionError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof ComputerUseSessionError) {
    sendJsonResponse(res, sessionErrorStatus(error), {
      error: error.message,
      code: error.code,
    });
    return;
  }
  sendJsonErrorResponse(res, 500, "Computer-use session operation failed");
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
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
    url.pathname === "/api/computer-use/sessions/stream"
  ) {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    const service = getComputerUseSessionService(state);
    if (!service) {
      sendJsonErrorResponse(
        res,
        404,
        "Computer use session service not available",
      );
      return true;
    }
    const queryCursor = url.searchParams.get("afterEventId");
    const headerCursor = firstHeaderValue(req.headers["last-event-id"]);
    const rawCursor = queryCursor ?? headerCursor ?? "0";
    const afterEventId = /^\d+$/.test(rawCursor) ? Number(rawCursor) : -1;
    if (!Number.isSafeInteger(afterEventId) || afterEventId < 0) {
      sendJsonErrorResponse(
        res,
        400,
        "afterEventId must be a non-negative integer",
      );
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
      sessions: service.listSessions(),
      events: service.getSessionEvents(afterEventId),
    });
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
    if (typeof heartbeat === "object" && "unref" in heartbeat)
      heartbeat.unref();
    const unsubscribe = service.subscribeSessions((event) => {
      res.write(`id: ${event.eventId}\n`);
      writeSseEvent(res, { type: "event", event });
    });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    req.on("aborted", cleanup);
    return true;
  }

  if (url.pathname === "/api/computer-use/sessions") {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    const service = getComputerUseSessionService(state);
    if (!service) {
      sendJsonErrorResponse(
        res,
        404,
        "Computer use session service not available",
      );
      return true;
    }
    if (method === "GET") {
      sendJsonResponse(res, 200, { sessions: service.listSessions() });
      return true;
    }
    if (method === "POST") {
      const body = await readCompatJsonBody(req, res);
      if (!body) return true;
      if (
        (body.label !== undefined && typeof body.label !== "string") ||
        (body.leaseTtlMs !== undefined && typeof body.leaseTtlMs !== "number")
      ) {
        sendJsonErrorResponse(
          res,
          400,
          "label must be a string and leaseTtlMs must be a number",
        );
        return true;
      }
      const target = body.target;
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        sendJsonErrorResponse(res, 400, "target must be an object");
        return true;
      }
      const targetRecord = target as Record<string, unknown>;
      if (typeof targetRecord.kind !== "string") {
        sendJsonErrorResponse(res, 400, "target.kind must be a string");
        return true;
      }
      if (
        (targetRecord.targetId !== undefined &&
          typeof targetRecord.targetId !== "string") ||
        (targetRecord.viewerUrl !== undefined &&
          typeof targetRecord.viewerUrl !== "string")
      ) {
        sendJsonErrorResponse(
          res,
          400,
          "targetId and viewerUrl must be strings",
        );
        return true;
      }
      try {
        const session = service.createSession({
          ...(typeof body.label === "string" ? { label: body.label } : {}),
          ...(body.leaseTtlMs !== undefined
            ? { leaseTtlMs: body.leaseTtlMs }
            : {}),
          target: {
            kind: targetRecord.kind as CreateComputerUseSessionInput["target"]["kind"],
            ...(typeof targetRecord.targetId === "string"
              ? { targetId: targetRecord.targetId }
              : {}),
            ...(typeof targetRecord.viewerUrl === "string"
              ? { viewerUrl: targetRecord.viewerUrl }
              : {}),
          },
        });
        sendJsonResponse(res, 201, { session });
      } catch (error) {
        // error-policy:J1 HTTP boundary translates typed session errors.
        sendSessionError(res, error);
      }
      return true;
    }
  }

  const sessionActionMatch =
    /^\/api\/computer-use\/sessions\/([^/]+)\/actions$/.exec(url.pathname);
  if (method === "POST" && sessionActionMatch) {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    const service = getComputerUseSessionService(state);
    if (!service) {
      sendJsonErrorResponse(
        res,
        404,
        "Computer use session service not available",
      );
      return true;
    }
    const sessionId = decodePathComponent(sessionActionMatch[1] ?? "");
    if (sessionId === null) {
      sendJsonErrorResponse(
        res,
        400,
        "Invalid session id: malformed URL encoding",
      );
      return true;
    }
    const body = await readCompatJsonBody(req, res);
    if (!body) return true;
    const expectedSequence = nonNegativeInteger(body.expectedSequence);
    if (
      typeof body.actionId !== "string" ||
      typeof body.command !== "string" ||
      expectedSequence === null ||
      (body.parameters !== undefined &&
        (!body.parameters ||
          typeof body.parameters !== "object" ||
          Array.isArray(body.parameters)))
    ) {
      sendJsonErrorResponse(
        res,
        400,
        "actionId, command, non-negative expectedSequence, and object parameters are required",
      );
      return true;
    }
    try {
      const outcome = await service.executeSessionAction(sessionId, {
        actionId: body.actionId,
        command: body.command,
        expectedSequence,
        ...(body.parameters
          ? { parameters: body.parameters as Record<string, unknown> }
          : {}),
      });
      sendJsonResponse(
        res,
        outcome.result &&
          typeof outcome.result === "object" &&
          "success" in outcome.result &&
          outcome.result.success === false
          ? 422
          : 200,
        outcome,
      );
    } catch (error) {
      // error-policy:J1 HTTP boundary translates typed session errors.
      sendSessionError(res, error);
    }
    return true;
  }

  const sessionLeaseMatch =
    /^\/api\/computer-use\/sessions\/([^/]+)\/lease$/.exec(url.pathname);
  if (method === "POST" && sessionLeaseMatch) {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    const service = getComputerUseSessionService(state);
    if (!service) {
      sendJsonErrorResponse(
        res,
        404,
        "Computer use session service not available",
      );
      return true;
    }
    const sessionId = decodePathComponent(sessionLeaseMatch[1] ?? "");
    if (sessionId === null) {
      sendJsonErrorResponse(
        res,
        400,
        "Invalid session id: malformed URL encoding",
      );
      return true;
    }
    const body = await readCompatJsonBody(req, res);
    if (!body) return true;
    if (body.leaseTtlMs !== undefined && typeof body.leaseTtlMs !== "number") {
      sendJsonErrorResponse(res, 400, "leaseTtlMs must be a number");
      return true;
    }
    try {
      const session = service.renewSessionLease(sessionId, body.leaseTtlMs);
      sendJsonResponse(res, 200, { session });
    } catch (error) {
      // error-policy:J1 HTTP boundary translates typed session errors.
      sendSessionError(res, error);
    }
    return true;
  }

  const sessionFrameMatch =
    /^\/api\/computer-use\/sessions\/([^/]+)\/frame$/.exec(url.pathname);
  if (method === "GET" && sessionFrameMatch) {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    const service = getComputerUseSessionService(state);
    if (!service) {
      sendJsonErrorResponse(
        res,
        404,
        "Computer use session service not available",
      );
      return true;
    }
    const sessionId = decodePathComponent(sessionFrameMatch[1] ?? "");
    if (sessionId === null) {
      sendJsonErrorResponse(
        res,
        400,
        "Invalid session id: malformed URL encoding",
      );
      return true;
    }
    try {
      res.setHeader("cache-control", "no-store");
      sendJsonResponse(res, 200, {
        frame: await service.captureSessionFrame(sessionId),
      });
    } catch (error) {
      // error-policy:J1 HTTP boundary translates typed session errors.
      sendSessionError(res, error);
    }
    return true;
  }

  const sessionMatch = /^\/api\/computer-use\/sessions\/([^/]+)$/.exec(
    url.pathname,
  );
  if ((method === "GET" || method === "DELETE") && sessionMatch) {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    const service = getComputerUseSessionService(state);
    if (!service) {
      sendJsonErrorResponse(
        res,
        404,
        "Computer use session service not available",
      );
      return true;
    }
    const sessionId = decodePathComponent(sessionMatch[1] ?? "");
    if (sessionId === null) {
      sendJsonErrorResponse(
        res,
        400,
        "Invalid session id: malformed URL encoding",
      );
      return true;
    }
    try {
      if (method === "DELETE") {
        sendJsonResponse(res, 200, {
          session: service.closeSession(sessionId),
        });
      } else {
        const session = service.getSession(sessionId);
        if (!session) {
          sendJsonErrorResponse(res, 404, "Computer-use session not found");
        } else {
          sendJsonResponse(res, 200, { session });
        }
      }
    } catch (error) {
      // error-policy:J1 HTTP boundary translates typed session errors.
      sendSessionError(res, error);
    }
    return true;
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
