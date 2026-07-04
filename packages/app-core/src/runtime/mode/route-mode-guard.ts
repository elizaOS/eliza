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
import type { Route } from "@elizaos/core";
import { sendJsonError } from "../../api/response";
import { findRouteModeRule } from "./route-mode-matrix";
import { getRuntimeModeSnapshot, type RuntimeMode } from "./runtime-mode";

export interface ModeGateOutcome {
  /** True when the dispatcher should stop — guard wrote a 404. */
  handled: boolean;
  /** The active runtime mode at gate time. */
  mode: RuntimeMode;
}

export interface RuntimeRouteModeRule {
  path: string;
  method: Route["type"];
  modes: ReadonlyArray<RuntimeMode>;
  reason: string;
}

export interface RouteModeRuntimeLike {
  routes?: ReadonlyArray<Route>;
}

function matchPluginRoutePath(pattern: string, pathname: string): boolean {
  const norm = (p: string) => p.split("/").filter((s) => s.length > 0);
  const patternSegments = norm(pattern);
  const pathSegments = norm(pathname);

  for (let i = 0; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i];
    const pathSegment = pathSegments[i];
    if (!patternSegment) return false;
    if (patternSegment.startsWith(":") && patternSegment.endsWith("*")) {
      return pathSegments.slice(i).length > 0;
    }
    if (pathSegment === undefined) return false;
    if (patternSegment.startsWith(":")) continue;
    if (patternSegment !== pathSegment) return false;
  }
  return patternSegments.length === pathSegments.length;
}

function isRuntimeModeList(
  value: unknown,
): value is ReadonlyArray<RuntimeMode> {
  return (
    Array.isArray(value) &&
    value.every(
      (mode) =>
        mode === "local" ||
        mode === "local-only" ||
        mode === "cloud" ||
        mode === "remote",
    )
  );
}

export function findRegisteredRouteModeRule(args: {
  runtime?: RouteModeRuntimeLike | null;
  pathname: string;
  method: string;
}): RuntimeRouteModeRule | null {
  const method = args.method.toUpperCase();
  for (const route of args.runtime?.routes ?? []) {
    if (route.type === "STATIC" || route.type !== method) continue;
    if (!isRuntimeModeList(route.modes) || route.modes.length === 0) continue;
    if (!matchPluginRoutePath(route.path, args.pathname)) continue;
    return {
      path: route.path,
      method: route.type,
      modes: route.modes,
      reason: route.modeReason ?? "runtime route visibility declaration",
    };
  }
  return null;
}

export function applyRouteModeGuard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime?: RouteModeRuntimeLike | null,
): ModeGateOutcome {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();
  const snapshot = getRuntimeModeSnapshot();

  const rule =
    findRegisteredRouteModeRule({
      runtime,
      pathname: url.pathname,
      method,
    }) ?? findRouteModeRule(url.pathname, method);
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
