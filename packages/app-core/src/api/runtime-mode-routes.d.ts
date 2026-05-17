/**
 * `GET /api/runtime/mode` — single source of truth for the active runtime
 * mode. The UI shell consumes this on boot so its `useRuntimeMode()` hook
 * can hard-render-nothing for mode-restricted panels.
 *
 * The response intentionally omits `remoteApiBase` / `remoteAccessToken`
 * — those are credentials the controller already holds; leaking them to
 * a browser session would broaden the trust boundary.
 */
import type http from "node:http";
import type { CompatRuntimeState } from "./compat-route-shared";
export declare function handleRuntimeModeRoute(req: http.IncomingMessage, res: http.ServerResponse, state: CompatRuntimeState): Promise<boolean>;
//# sourceMappingURL=runtime-mode-routes.d.ts.map