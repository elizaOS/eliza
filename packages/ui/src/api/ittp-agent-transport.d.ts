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
export declare function createIttpAgentTransport(
  handler: IttpRouteKernel,
): AgentRequestTransport;
//# sourceMappingURL=ittp-agent-transport.d.ts.map
