/**
 * Route-level mode guard.
 *
 * Runs BEFORE handler logic. If the active runtime mode is not in the
 * route's matrix entry, responds with 404 (hidden, not 403 — we do not
 * want cloud mode to be probeable for local-inference state) and returns
 * `true` so the dispatcher stops walking handlers.
 *
 * No defensive try/catch: a config-load failure is the runtime's problem,
 * not the gate's.
 */

import type http from "node:http";
import { sendJsonError } from "../../api/response";
import { findRouteModeRule } from "./route-mode-matrix";
import { getRuntimeModeSnapshot, type RuntimeMode } from "./runtime-mode";

export interface ModeGateOutcome {
  /** True when the dispatcher should stop — guard wrote a 404. */
  handled: boolean;
  /** The active runtime mode at gate time. */
  mode: RuntimeMode;
}

export function applyRouteModeGuard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): ModeGateOutcome {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();
  const snapshot = getRuntimeModeSnapshot();

  const rule = findRouteModeRule(url.pathname, method);
  if (!rule) {
    return { handled: false, mode: snapshot.mode };
  }

  if (rule.modes.includes(snapshot.mode)) {
    return { handled: false, mode: snapshot.mode };
  }

  // Hidden — not forbidden. Don't include the mode or rule reason in the
  // body; cloud mode must not be able to probe local-inference state.
  sendJsonError(res, 404, "Not found");
  return { handled: true, mode: snapshot.mode };
}
