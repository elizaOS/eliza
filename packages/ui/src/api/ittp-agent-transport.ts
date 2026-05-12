import type { AgentRequestTransport } from "./transport";

export interface IttpAgentRequestContext {
  timeoutMs?: number;
}

export type IttpAgentRequestHandler = (
  request: Request,
  context: IttpAgentRequestContext,
) => Promise<Response>;

export interface FetchRouteKernel {
  fetch(request: Request): Response | Promise<Response>;
}

export type IttpRouteKernel = IttpAgentRequestHandler | FetchRouteKernel;

function dispatchIttpRouteKernel(
  kernel: IttpRouteKernel,
  request: Request,
  context: IttpAgentRequestContext,
): Promise<Response> {
  if (typeof kernel === "function") return kernel(request, context);
  return Promise.resolve(kernel.fetch(request));
}

/**
 * In-thread transport protocol adapter.
 *
 * It lets a fetch-shaped route kernel satisfy ElizaClient requests without
 * opening a TCP listener. Android can keep using loopback while iOS uses this
 * path for its in-WebView local agent.
 *
 * Hono apps expose the same `app.fetch(request)` shape, so they can be passed
 * directly once a real shared route kernel exists.
 */
export function createIttpAgentTransport(
  handler: IttpRouteKernel,
): AgentRequestTransport {
  return {
    request(url, init, context) {
      const request = new Request(url, init);
      return dispatchIttpRouteKernel(handler, request, {
        timeoutMs: context?.timeoutMs,
      });
    },
  };
}
