import http from "node:http";
import { ensureCompatApiAuthorized, ensureCompatSensitiveRouteAuthorized } from "./auth";
import { type CompatRuntimeState, readCompatJsonBody } from "./compat-route-shared";
import {
  sendJson as sendJsonResponse,
  sendJsonError as sendJsonErrorResponse,
} from "./response";

type ComputerUseApprovalSnapshot = {
  mode: string;
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
  mode: string;
  requestedAt: string;
  resolvedAt: string;
  reason?: string;
};

type ComputerUseServiceLike = {
  getApprovalSnapshot(): ComputerUseApprovalSnapshot;
  resolveApproval(
    id: string,
    approved: boolean,
    reason?: string,
  ): ComputerUseApprovalResolution | null;
};

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
    typeof candidate.resolveApproval !== "function"
  ) {
    return null;
  }

  return candidate as ComputerUseServiceLike;
}

export async function handleComputerUseCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!url.pathname.startsWith("/api/computer-use/approvals")) {
    return false;
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
