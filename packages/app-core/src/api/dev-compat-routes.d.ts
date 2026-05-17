import type http from "node:http";
import { type CompatRuntimeState } from "./compat-route-shared";
/**
 * Dev observability routes (loopback where noted).
 *
 * - `GET /api/dev/stack`
 * - `GET /api/dev/route-catalog`
 * - `GET /api/dev/cursor-screenshot`
 * - `GET /api/dev/console-log`
 * - `GET /api/dev/voice-latency`
 */
export declare function handleDevCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean>;
//# sourceMappingURL=dev-compat-routes.d.ts.map
