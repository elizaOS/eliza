/**
 * Applies the runtime snapshot barrier at transport admission boundaries.
 * HTTP mutations and WebSocket upgrades consult the same runtime-scoped state,
 * while the long-running snapshot transfer alone receives an infinite socket
 * timeout and begins its own one-way drain.
 */
import type http from "node:http";
import {
  getSnapshotCaptureBarrier,
  type IAgentRuntime,
  type SnapshotCaptureBarrierStatus,
  type SnapshotMutationLease,
} from "@elizaos/core";

const SNAPSHOT_TRANSFER_PATHS = new Set(["/api/snapshot", "/api/restore"]);
const TRANSFER_SAFE_RUNTIME_PATHS = new Set(["/api/health", "/api/status"]);

export function applySnapshotTransferTimeoutPolicy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  requestReceiveTimeoutMs: number,
): void {
  if (SNAPSHOT_TRANSFER_PATHS.has(pathname)) {
    req.setTimeout(0);
    res.setTimeout(0);
    req.socket.setTimeout(0);
    return;
  }
  if (
    requestReceiveTimeoutMs <= 0 ||
    !Number.isFinite(requestReceiveTimeoutMs) ||
    req.complete
  ) {
    return;
  }

  let settled = false;
  const cleanup = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    req.off("end", cleanup);
    req.off("aborted", cleanup);
    req.off("close", cleanup);
  };
  const deadline = setTimeout(() => {
    if (req.complete || req.destroyed) {
      cleanup();
      return;
    }
    cleanup();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.statusCode = 408;
    res.setHeader("Connection", "close");
    res.once("finish", () => req.socket.destroy());
    res.end();
  }, requestReceiveTimeoutMs);
  deadline.unref();
  req.once("end", cleanup);
  req.once("aborted", cleanup);
  req.once("close", cleanup);
}

export function admitHttpRuntimeRequest(
  runtime: IAgentRuntime | null,
  method: string,
  pathname: string,
): SnapshotMutationLease | undefined {
  if (!runtime || SNAPSHOT_TRANSFER_PATHS.has(pathname)) {
    return undefined;
  }
  if (
    (method === "GET" || method === "HEAD") &&
    !pathname.startsWith("/api/")
  ) {
    return undefined;
  }

  const barrier = getSnapshotCaptureBarrier(runtime);
  if (
    method === "GET" &&
    TRANSFER_SAFE_RUNTIME_PATHS.has(pathname) &&
    barrier.status().phase !== "accepting"
  ) {
    return undefined;
  }
  return barrier.admitMutation();
}

export function snapshotUpgradeUnavailableStatus(
  runtime: IAgentRuntime | null,
): SnapshotCaptureBarrierStatus | null {
  if (!runtime) return null;
  const status = getSnapshotCaptureBarrier(runtime).status();
  return status.phase === "accepting" ? null : status;
}
