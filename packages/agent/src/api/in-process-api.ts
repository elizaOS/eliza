import type { RouteHandlerResult } from "@elizaos/core";
import {
  buildLegacyShim,
  capturedToResult,
  type DispatchRouteArgs,
} from "./dispatch-route.ts";
import type { RouteKernel } from "./route-kernel.ts";

const kernels = new WeakMap<object, RouteKernel>();

/** Register the already-created server kernel for a local runtime. */
export function registerInProcessApi(
  runtime: object,
  kernel: RouteKernel,
): () => void {
  kernels.set(runtime, kernel);
  return () => {
    if (kernels.get(runtime) === kernel) kernels.delete(runtime);
  };
}

/** Use the full server routing and authentication boundary without a TCP listener. */
export async function dispatchApiRoute(
  args: DispatchRouteArgs,
): Promise<RouteHandlerResult> {
  if (!args.inProcess || !args.isAuthorized()) {
    return { status: 401, body: { error: "Unauthorized" } };
  }
  const kernel = args.runtime ? kernels.get(args.runtime) : undefined;
  if (!kernel) {
    return {
      status: 503,
      body: { error: "Local API kernel is not initialized" },
    };
  }
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
  try {
    await kernel.handle(req, res);
    if (!captured.ended)
      throw new Error("Local API handler did not finish its response");
    return capturedToResult(captured);
  } finally {
    req.destroy();
    req.socket.destroy();
  }
}
