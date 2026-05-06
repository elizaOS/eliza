import type { AgentRequestTransport } from "./transport";

export interface IttpAgentRequestContext {
  timeoutMs?: number;
}

export type IttpAgentRequestHandler = (
  request: Request,
  context: IttpAgentRequestContext,
) => Promise<Response>;

/**
 * In-thread transport protocol adapter.
 *
 * It lets a fetch-shaped route kernel satisfy ElizaClient requests without
 * opening a TCP listener. Android can keep using loopback while iOS uses this
 * path for its in-WebView local agent.
 */
export function createIttpAgentTransport(
  handler: IttpAgentRequestHandler,
): AgentRequestTransport {
  return {
    request(url, init, context) {
      const request = new Request(url, init);
      return handler(request, { timeoutMs: context?.timeoutMs });
    },
  };
}
