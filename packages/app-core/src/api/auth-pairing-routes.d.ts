import type http from "node:http";
import { type CompatRuntimeState } from "./compat-route-shared";
export declare function _resetAuthPairingStateForTests(): void;
export declare function ensureAuthPairingCodeForRemoteAccess(): {
  code: string;
  expiresAt: number;
} | null;
/**
 * Auth / pairing routes:
 *
 * - `GET  /api/onboarding/status`
 * - `GET  /api/auth/status`
 * - `GET  /api/auth/pair-code`
 * - `POST /api/auth/pair`
 */
export declare function handleAuthPairingCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean>;
//# sourceMappingURL=auth-pairing-routes.d.ts.map
