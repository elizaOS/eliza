import type http from "node:http";
import type { CompatRuntimeState } from "./compat-route-shared";
/**
 * Wake telemetry visible to /api/health. Wave 5 reads `lastWakeFiredAt` to
 * surface "last background tick" on the dashboard.
 */
export interface WakeTelemetry {
  lastWakeFiredAt: number | null;
  lastWakeKind: "refresh" | "processing" | null;
  lastWakeDurationMs: number | null;
  lastWakeRanTasks: number | null;
  lastWakeError: string | null;
}
export declare function getWakeTelemetry(): Readonly<WakeTelemetry>;
export declare function __resetWakeTelemetryForTests(): void;
/**
 * Returns the bearer secret that wake POSTs must present. Generates one on
 * first call and reuses it for the process lifetime.
 */
export declare function getDeviceSecret(): string;
export declare function __setDeviceSecretForTests(secret: string | null): void;
export declare function __setDeviceSecretPathForTests(
  filePath: string | null,
): void;
export declare function handleInternalWakeRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean>;
//# sourceMappingURL=internal-routes.d.ts.map
