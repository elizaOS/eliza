/**
 * Runtime-mode request hooks shared by every HTTP host. The visibility hook
 * runs before auth so hidden-in-mode routes return a plain 404 without making
 * mode state probeable. The remote forwarder hook runs only after the normal
 * auth gate has accepted the request, because it attaches the controller's
 * target token and must never turn an unauthenticated caller into the target's
 * owner.
 *
 * Both the bare `@elizaos/agent` server (`api/server.ts` request dispatch) and
 * the `@elizaos/app` compat pipeline call these, so the mode contract
 * holds no matter which host binds the port — the gate used to live only in
 * app, leaving `bun run start` (the bare agent) ungated.
 */

import type http from "node:http";
import { forwardRemoteCloudMutation } from "./remote-forwarder.ts";
import {
  applyRouteModeGuard,
  type RouteModeRuntimeLike,
} from "./route-mode-guard.ts";

import type { RuntimeModeSnapshot } from "./runtime-mode.ts";

export async function handleRuntimeModePreDispatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime?: RouteModeRuntimeLike | null,
  snapshot?: RuntimeModeSnapshot,
): Promise<boolean> {
  const gate = applyRouteModeGuard(req, res, runtime, snapshot);
  return gate.handled;
}

export async function handleRuntimeModeRemoteForward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  snapshot?: RuntimeModeSnapshot,
): Promise<boolean> {
  return forwardRemoteCloudMutation(req, res, snapshot);
}
