/**
 * useRuntimeMode — reads the authoritative runtime-mode snapshot from
 * `GET /api/runtime/mode`.
 *
 * The endpoint is the single source of truth for `local` / `local-only` /
 * `cloud` / `remote` (see `packages/app-core/src/runtime/mode/runtime-mode.ts`
 * and `runtime-mode-routes.ts`). UI surfaces that previously inferred mode
 * from `activeServer` / `clientBaseUrl` heuristics should consume this hook
 * so the dashboard agrees with the server's resolved configuration.
 *
 * The result is cached at module scope and shared across all consumers — a
 * single `GET /api/runtime/mode` per session is enough; the snapshot only
 * changes when the user reconfigures deployment, which itself triggers a
 * full reload.
 *
 * Failure mode: when the endpoint is unreachable (no auth, no server, older
 * build), the hook returns `phase: "unavailable"` and callers fall back to
 * local heuristics. The snapshot is advisory; it never gates security.
 */
import {
  type RuntimeMode,
  type RuntimeModeSnapshot,
} from "../api/runtime-mode-client";
export type UseRuntimeModeState =
  | {
      phase: "loading";
    }
  | {
      phase: "ready";
      snapshot: RuntimeModeSnapshot;
    }
  | {
      phase: "unavailable";
    };
export interface UseRuntimeModeResult {
  state: UseRuntimeModeState;
  /** Convenience: `null` until the snapshot resolves. */
  mode: RuntimeMode | null;
  /** True for both `local` and `local-only`. */
  isLocalOnly: boolean;
  isCloudMode: boolean;
  isRemoteMode: boolean;
  refetch: () => void;
}
/**
 * Test-only escape hatch — clears the module-scope cache so a hook test
 * can verify the second mount short-circuits the network call. Not
 * exported from the package barrel.
 */
export declare function __resetRuntimeModeCacheForTests(): void;
export declare function useRuntimeMode(): UseRuntimeModeResult;
//# sourceMappingURL=useRuntimeMode.d.ts.map
