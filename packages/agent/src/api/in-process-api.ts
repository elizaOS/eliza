import type { RouteHandlerResult } from "@elizaos/host/protocol";
import { getViewClientScope } from "../runtime/view-client-context.ts";
import {
  buildLegacyShim,
  capturedToResult,
  type DispatchRouteArgs,
} from "./dispatch-route.ts";
import { markAuthenticatedInProcessRequest } from "./in-process-request.ts";
import type { RouteKernel } from "./route-kernel.ts";

const kernels = new WeakMap<
  object,
  { defaultKernel?: RouteKernel; hosts: WeakMap<object, RouteKernel> }
>();
/** Register one existing kernel without allowing another host to replace its identity. */
export function registerInProcessApi(
  runtime: object,
  kernel: RouteKernel,
  hostKey?: object,
): () => void {
  let entry = kernels.get(runtime);
  if (!entry) {
    entry = { hosts: new WeakMap() };
    kernels.set(runtime, entry);
  }
  if (hostKey) entry.hosts.set(hostKey, kernel);
  else entry.defaultKernel = kernel;
  return () => {
    if (hostKey) {
      if (entry.hosts.get(hostKey) === kernel) entry.hosts.delete(hostKey);
    } else if (entry.defaultKernel === kernel) delete entry.defaultKernel;
  };
}
/** Use the full server routing and authentication boundary without a TCP listener. */
export async function dispatchApiRoute(
  args: DispatchRouteArgs,
): Promise<RouteHandlerResult> {
  args.signal?.throwIfAborted();
  if (!args.inProcess || !args.isAuthorized()) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  const scope = getViewClientScope(),
    parent = scope?.request;
  if (
    args.hostKey &&
    (!parent ||
      parent.signal.aborted ||
      !parent.authorization?.ok ||
      parent.runtime !== args.runtime ||
      scope?.hostKey !== args.hostKey)
  )
    return {
      status: 403,
      body: { error: "Original authenticated request is no longer active" },
    };
  const entry = args.runtime ? kernels.get(args.runtime) : undefined;
  const kernel = args.hostKey
    ? entry?.hosts.get(args.hostKey)
    : entry?.defaultKernel;
  if (!kernel) {
    return {
      status: 503,
      body: { error: "Local API kernel is not initialized" },
    };
  }
  const signal =
    args.hostKey && parent
      ? AbortSignal.any([parent.signal, ...(args.signal ? [args.signal] : [])])
      : args.signal;
  signal?.throwIfAborted();
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(args.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value])
      query.append(name, item);
  }
  const path = `${args.path}${query.size ? `?${query}` : ""}`;
  const { req, res, captured } = buildLegacyShim({
    ...args,
    path,
    query: args.query ?? {},
    params: {},
    body: args.body,
  });
  const abort = () => {
    req.emit("aborted");
    res.destroy();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    markAuthenticatedInProcessRequest(
      req,
      args.hostKey ? parent?.authorization : undefined,
    );
    await kernel.handle(req, res);
    signal?.throwIfAborted();
    if (captured.failure) throw captured.failure;
    if (!captured.ended)
      throw new Error("Local API handler did not finish its response");
    return capturedToResult(captured);
  } finally {
    signal?.removeEventListener("abort", abort);
    req.destroy();
    req.socket.destroy();
  }
}
