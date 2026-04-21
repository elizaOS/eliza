import type http from "node:http";
import { stringToUuid } from "@elizaos/core";
import {
  type BenchmarkSession,
  type CuaServiceLike,
  compactCuaResult,
  isRecord,
  parseBooleanValue,
} from "./server-utils";

const CUA_UNAVAILABLE_ERROR =
  "CUA service is unavailable. Set ELIZA_ENABLE_CUA=1 and configure CUA_HOST (or CUA_API_KEY + CUA_SANDBOX_NAME).";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
  });
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

export async function handleCuaRoute(params: {
  pathname: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  getCuaService: () => CuaServiceLike | null;
  activeSession: BenchmarkSession | null;
}): Promise<boolean> {
  const { pathname, req, res, getCuaService, activeSession } = params;

  const resolveCuaRoomId = (candidate: unknown): string => {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    if (activeSession?.roomId) {
      return activeSession.roomId;
    }
    return stringToUuid(`benchmark-cua-room:${Date.now()}:${Math.random()}`);
  };

  if (pathname === "/api/benchmark/cua/status" && req.method === "GET") {
    const service = getCuaService();
    if (!service) {
      writeJson(res, 503, { ok: false, error: CUA_UNAVAILABLE_ERROR });
      return true;
    }

    try {
      const status = service.getStatus();
      writeJson(res, 200, { ok: true, status });
    } catch (err: unknown) {
      writeJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  if (pathname === "/api/benchmark/cua/screenshot" && req.method === "GET") {
    const service = getCuaService();
    if (!service) {
      writeJson(res, 503, { ok: false, error: CUA_UNAVAILABLE_ERROR });
      return true;
    }

    try {
      const screenshot = await service.screenshotBase64();
      writeJson(res, 200, {
        ok: true,
        screenshot,
        mimeType: "image/png",
        timestamp: Date.now(),
      });
    } catch (err: unknown) {
      writeJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  if (pathname === "/api/benchmark/cua/run" && req.method === "POST") {
    const body = await readBody(req);
    const service = getCuaService();
    if (!service) {
      writeJson(res, 503, { ok: false, error: CUA_UNAVAILABLE_ERROR });
      return true;
    }

    try {
      const parsed = body.trim()
        ? (JSON.parse(body) as {
            goal?: unknown;
            room_id?: unknown;
            roomId?: unknown;
            auto_approve?: unknown;
            autoApprove?: unknown;
            include_screenshots?: unknown;
            includeScreenshots?: unknown;
            max_approvals?: unknown;
            maxApprovals?: unknown;
          })
        : {};

      const goal = typeof parsed.goal === "string" ? parsed.goal.trim() : "";
      if (!goal) {
        writeJson(res, 400, {
          ok: false,
          error: 'Missing non-empty "goal" in request body',
        });
        return true;
      }

      const roomId = resolveCuaRoomId(parsed.room_id ?? parsed.roomId);
      const autoApprove = parseBooleanValue(
        parsed.auto_approve ?? parsed.autoApprove,
        false,
      );
      const includeScreenshots = parseBooleanValue(
        parsed.include_screenshots ?? parsed.includeScreenshots,
        false,
      );

      const maxApprovalsRaw =
        typeof parsed.max_approvals === "number"
          ? parsed.max_approvals
          : typeof parsed.maxApprovals === "number"
            ? parsed.maxApprovals
            : 5;
      const maxApprovals =
        Number.isFinite(maxApprovalsRaw) && maxApprovalsRaw > 0
          ? Math.floor(maxApprovalsRaw)
          : 5;

      let approvals = 0;
      let result = await service.runTask(roomId, goal);

      while (
        autoApprove &&
        isRecord(result) &&
        result.status === "paused_for_approval" &&
        approvals < maxApprovals
      ) {
        approvals += 1;
        result = await service.approveLatest(roomId);
      }

      writeJson(res, 200, {
        ok: true,
        room_id: roomId,
        approvals,
        auto_approve: autoApprove,
        result: compactCuaResult(result, includeScreenshots),
      });
    } catch (err: unknown) {
      writeJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return true;
  }

  if (pathname === "/api/benchmark/cua/approve" && req.method === "POST") {
    const body = await readBody(req);
    const service = getCuaService();
    if (!service) {
      writeJson(res, 503, { ok: false, error: CUA_UNAVAILABLE_ERROR });
      return true;
    }

    try {
      const parsed = body.trim()
        ? (JSON.parse(body) as { room_id?: unknown; roomId?: unknown })
        : {};
      const roomId = resolveCuaRoomId(parsed.room_id ?? parsed.roomId);
      const result = await service.approveLatest(roomId);
      writeJson(res, 200, {
        ok: true,
        room_id: roomId,
        result: compactCuaResult(result, false),
      });
    } catch (err: unknown) {
      writeJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return true;
  }

  if (pathname === "/api/benchmark/cua/cancel" && req.method === "POST") {
    const body = await readBody(req);
    const service = getCuaService();
    if (!service) {
      writeJson(res, 503, { ok: false, error: CUA_UNAVAILABLE_ERROR });
      return true;
    }

    try {
      const parsed = body.trim()
        ? (JSON.parse(body) as { room_id?: unknown; roomId?: unknown })
        : {};
      const roomId = resolveCuaRoomId(parsed.room_id ?? parsed.roomId);
      await service.cancelLatest(roomId);
      writeJson(res, 200, {
        ok: true,
        room_id: roomId,
        status: "cancelled",
      });
    } catch (err: unknown) {
      writeJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return true;
  }

  return false;
}
