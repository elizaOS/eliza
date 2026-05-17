/**
 * GET /api/runtime/mode — single source of truth for the active runtime
 * mode. The server returns a redacted snapshot (never `remoteAccessToken`,
 * never `remoteApiBase`); the UI mirrors only the fields it needs.
 *
 * Pairs with `useRuntimeMode()` in `../hooks/useRuntimeMode.ts`. The route
 * handler lives in `packages/app-core/src/api/runtime-mode-routes.ts`.
 */
export type RuntimeMode = "local" | "local-only" | "cloud" | "remote";
export type RuntimeDeploymentRuntime = "local" | "cloud" | "remote";
export interface RuntimeModeSnapshot {
  mode: RuntimeMode;
  deploymentRuntime: RuntimeDeploymentRuntime;
  isRemoteController: boolean;
  remoteApiBaseConfigured: boolean;
}
/**
 * Fetch the runtime-mode snapshot. Returns `null` when the endpoint is
 * unreachable or returns a non-2xx — callers fall back to local heuristics
 * (the snapshot is advisory, never load-bearing for security).
 */
export declare function fetchRuntimeModeSnapshot(): Promise<RuntimeModeSnapshot | null>;
//# sourceMappingURL=runtime-mode-client.d.ts.map
