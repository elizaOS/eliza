/**
 * `GET /api/runtime/mode` — single source of truth for the active runtime
 * mode. The UI shell consumes this on boot so its `useRuntimeMode()` hook
 * can hard-render-nothing for mode-restricted panels.
 *
 * The response intentionally omits `remoteApiBase` / `remoteAccessToken`
 * — those are credentials the controller already holds; leaking them to
 * a browser session would broaden the trust boundary.
 */

import type http from "node:http";
import { getRuntimeModeSnapshot } from "../runtime/mode/runtime-mode";
import { ensureRouteAuthorized } from "./auth.ts";
import type { CompatRuntimeState } from "./compat-route-shared";
import { sendJson, sendJsonError } from "./response";

export async function handleRuntimeModeRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();
  if (url.pathname !== "/api/runtime/mode") return false;
  if (method !== "GET") {
    sendJsonError(res, 405, "Method not allowed");
    return true;
  }
  if (!(await ensureRouteAuthorized(req, res, state))) return true;

  const snapshot = getRuntimeModeSnapshot();
  sendJson(res, 200, {
    mode: snapshot.mode,
    deploymentRuntime: snapshot.deploymentTarget?.runtime ?? "local",
    isRemoteController: snapshot.mode === "remote",
    remoteApiBaseConfigured: Boolean(snapshot.remoteApiBase),
  });
  return true;
}
