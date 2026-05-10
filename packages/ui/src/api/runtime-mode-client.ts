/**
 * GET /api/runtime/mode — single source of truth for the active runtime
 * mode. The server returns a redacted snapshot (never `remoteAccessToken`,
 * never `remoteApiBase`); the UI mirrors only the fields it needs.
 *
 * Pairs with `useRuntimeMode()` in `../hooks/useRuntimeMode.ts`. The route
 * handler lives in `packages/app-core/src/api/runtime-mode-routes.ts`.
 */

import { getBootConfig } from "../config/boot-config";
import { fetchWithCsrf } from "./csrf-client";

export type RuntimeMode = "local" | "local-only" | "cloud" | "remote";

export type RuntimeDeploymentRuntime = "local" | "cloud" | "remote";

export interface RuntimeModeSnapshot {
  mode: RuntimeMode;
  deploymentRuntime: RuntimeDeploymentRuntime;
  isRemoteController: boolean;
  remoteApiBaseConfigured: boolean;
}

function modeBase(): string {
  if (typeof window === "undefined") return "";
  const apiBase = getBootConfig().apiBase;
  return apiBase ? apiBase.replace(/\/$/, "") : window.location.origin;
}

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return (
    value === "local" ||
    value === "local-only" ||
    value === "cloud" ||
    value === "remote"
  );
}

function isDeploymentRuntime(value: unknown): value is RuntimeDeploymentRuntime {
  return value === "local" || value === "cloud" || value === "remote";
}

/**
 * Fetch the runtime-mode snapshot. Returns `null` when the endpoint is
 * unreachable or returns a non-2xx — callers fall back to local heuristics
 * (the snapshot is advisory, never load-bearing for security).
 */
export async function fetchRuntimeModeSnapshot(): Promise<
  RuntimeModeSnapshot | null
> {
  let res: Response;
  try {
    res = await fetchWithCsrf(`${modeBase()}/api/runtime/mode`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as
    | {
        mode?: unknown;
        deploymentRuntime?: unknown;
        isRemoteController?: unknown;
        remoteApiBaseConfigured?: unknown;
      }
    | null;
  if (!body) return null;
  if (!isRuntimeMode(body.mode)) return null;
  if (!isDeploymentRuntime(body.deploymentRuntime)) return null;
  return {
    mode: body.mode,
    deploymentRuntime: body.deploymentRuntime,
    isRemoteController: body.isRemoteController === true,
    remoteApiBaseConfigured: body.remoteApiBaseConfigured === true,
  };
}
