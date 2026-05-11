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

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchRuntimeModeSnapshot,
  type RuntimeMode,
  type RuntimeModeSnapshot,
} from "../api/runtime-mode-client";

export type UseRuntimeModeState =
  | { phase: "loading" }
  | { phase: "ready"; snapshot: RuntimeModeSnapshot }
  | { phase: "unavailable" };

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

const subscribers = new Set<(state: UseRuntimeModeState) => void>();
let snapshot: UseRuntimeModeState = { phase: "loading" };
let inFlight: Promise<void> | null = null;

function publish(next: UseRuntimeModeState): void {
  snapshot = next;
  for (const subscriber of subscribers) subscriber(next);
}

async function refresh(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = fetchRuntimeModeSnapshot()
    .then((result) => {
      publish(
        result === null
          ? { phase: "unavailable" }
          : { phase: "ready", snapshot: result },
      );
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Test-only escape hatch — clears the module-scope cache so a hook test
 * can verify the second mount short-circuits the network call. Not
 * exported from the package barrel.
 */
export function __resetRuntimeModeCacheForTests(): void {
  snapshot = { phase: "loading" };
  inFlight = null;
}

export function useRuntimeMode(): UseRuntimeModeResult {
  const [state, setState] = useState<UseRuntimeModeState>(snapshot);
  const mountedRef = useRef(true);

  const refetch = useCallback(() => {
    if (!mountedRef.current) return;
    void refresh();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    subscribers.add(setState);
    setState(snapshot);
    if (snapshot.phase === "loading") void refresh();
    return () => {
      mountedRef.current = false;
      subscribers.delete(setState);
    };
  }, []);

  const mode = state.phase === "ready" ? state.snapshot.mode : null;
  return {
    state,
    mode,
    isLocalOnly: mode === "local" || mode === "local-only",
    isCloudMode: mode === "cloud",
    isRemoteMode: mode === "remote",
    refetch,
  };
}
