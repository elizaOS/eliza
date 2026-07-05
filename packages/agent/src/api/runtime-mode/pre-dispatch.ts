/**
 * Runtime-mode pre-dispatch hook: the single entry point every HTTP host runs
 * before its route handlers. Applies the mode-visibility gate (hidden routes
 * respond 404) and, in `remote` mode, forwards cloud-settings mutations to the
 * controlled target instead of executing them locally.
 *
 * Both the bare `@elizaos/agent` server (`api/server.ts` request dispatch) and
 * the `@elizaos/app-core` compat pipeline call this, so the mode contract holds
 * no matter which host binds the port — the gate used to live only in app-core,
 * leaving `bun run start` (the bare agent) ungated.
 *
 * Returns `true` when the request was fully handled (gated or forwarded) and
 * the caller must stop dispatching. Running it twice on one request is safe:
 * the second pass resolves the same mode, and the forwarder only consumes the
 * request body when it actually forwards (in which case it already returned
 * `true` on the first pass).
 */

import type http from "node:http";
import { forwardRemoteCloudMutation } from "./remote-forwarder.ts";
import {
  applyRouteModeGuard,
  type RouteModeRuntimeLike,
} from "./route-mode-guard.ts";

export async function handleRuntimeModePreDispatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime?: RouteModeRuntimeLike | null,
): Promise<boolean> {
  const gate = applyRouteModeGuard(req, res, runtime);
  if (gate.handled) return true;
  if (gate.mode === "remote") {
    return forwardRemoteCloudMutation(req, res);
  }
  return false;
}
