/**
 * Adapts the agent route dispatcher to Node's request-listener boundary. The
 * kernel owns the single failure translation point while feature routes remain
 * responsible only for validation and their typed results.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteKernel {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createRouteKernel(options: {
  dispatch(req: IncomingMessage, res: ServerResponse): Promise<void>;
  translateFailure(
    error: unknown,
    req: IncomingMessage,
    res: ServerResponse,
  ): void | Promise<void>;
}): RouteKernel {
  return {
    async handle(req, res) {
      try {
        await options.dispatch(req, res);
      } catch (error) {
        // error-policy:J1 HTTP is the outermost boundary for route failures.
        await options.translateFailure(error, req, res);
      }
    },
  };
}
