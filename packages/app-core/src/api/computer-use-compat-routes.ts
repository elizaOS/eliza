import type http from "node:http";
import {
  ensureCompatApiAuthorized,
  ensureCompatSensitiveRouteAuthorized,
  getCompatApiToken,
  getProvidedApiToken,
  tokenMatches,
} from "./auth";
import {
  type CompatRuntimeState,
  readCompatJsonBody,
} from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

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
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const initialSnapshot =
      service?.getApprovalSnapshot() ??
      ({
        mode: "full_control",
        pendingCount: 0,
        pendingApprovals: [],
      } satisfies ComputerUseApprovalSnapshot);

    writeSseEvent(res, {
      type: "snapshot",
      snapshot: initialSnapshot,
    });

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15_000);
    if (typeof heartbeat === "object" && "unref" in heartbeat) {
      heartbeat.unref();
    }

    const unsubscribe = service?.subscribeApprovals?.((snapshot) => {
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
    if (!ensureCompatApiAuthorized(req, res)) {
      return true;
    }

    const service = getComputerUseService(state);
    if (!service) {
      sendJsonResponse(res, 200, {
        mode: "full_control",
        pendingCount: 0,
        pendingApprovals: [],
      } satisfies ComputerUseApprovalSnapshot);
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
      decodeURIComponent(match[1]!),
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
