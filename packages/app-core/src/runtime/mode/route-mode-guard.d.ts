/**
 * Route-level mode guard.
 *
 * Runs BEFORE handler logic. If the active runtime mode is not in the
 * route's matrix entry, responds with 404 (hidden, not 403 — we do not
 * want cloud mode to be probeable for local-inference state) and returns
 * `true` so the dispatcher stops walking handlers.
 *
 * Config-load failures propagate to the runtime error handler.
 */
import type http from "node:http";
import { type RuntimeMode } from "./runtime-mode";
export interface ModeGateOutcome {
  /** True when the dispatcher should stop — guard wrote a 404. */
  handled: boolean;
  /** The active runtime mode at gate time. */
  mode: RuntimeMode;
}
export declare function applyRouteModeGuard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): ModeGateOutcome;
//# sourceMappingURL=route-mode-guard.d.ts.map
