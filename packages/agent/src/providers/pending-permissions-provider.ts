/**
 * Pending-permissions provider.
 *
 * Position `-5` — runs after the dynamic skill provider (`-10`) but before
 * neutral-priority providers so the planner sees pending permission state
 * alongside the active skill match.
 *
 * Surfaces only when `registry.pending()` is non-empty so we never bloat the
 * prompt for the steady state. Each line names the permission, current status,
 * and the most recent feature that was blocked.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { IPermissionsRegistry, PermissionState } from "@elizaos/shared";
import { PERMISSIONS_REGISTRY_SERVICE } from "../services/permissions-registry.ts";

/** Service id used by the concrete permissions registry service. */
export const PERMISSIONS_REGISTRY_SERVICE_ID = PERMISSIONS_REGISTRY_SERVICE;
const LEGACY_PERMISSIONS_REGISTRY_SERVICE_ID = "PERMISSIONS_REGISTRY_SERVICE";

interface PermissionsRegistryServiceLike {
  getRegistry?: () => IPermissionsRegistry;
  registry?: IPermissionsRegistry;
}

function resolveRegistry(runtime: IAgentRuntime): IPermissionsRegistry | null {
  const svc = (runtime.getService(PERMISSIONS_REGISTRY_SERVICE_ID) ??
    runtime.getService(LEGACY_PERMISSIONS_REGISTRY_SERVICE_ID)) as
    | (PermissionsRegistryServiceLike & Partial<IPermissionsRegistry>)
    | null
    | undefined;
  if (!svc) return null;
  if (typeof svc.pending === "function") {
    return svc as IPermissionsRegistry;
  }
  if (typeof svc.getRegistry === "function") {
    try {
      return svc.getRegistry();
    } catch {
      return null;
    }
  }
  return svc.registry ?? null;
}

const RELATIVE_TIME_MIN = 60_000;
const RELATIVE_TIME_HOUR = 60 * RELATIVE_TIME_MIN;
const RELATIVE_TIME_DAY = 24 * RELATIVE_TIME_HOUR;

function formatRelativeTime(now: number, then: number): string {
  const delta = Math.max(0, now - then);
  if (delta < RELATIVE_TIME_MIN) return "just now";
  if (delta < RELATIVE_TIME_HOUR) {
    const m = Math.floor(delta / RELATIVE_TIME_MIN);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (delta < RELATIVE_TIME_DAY) {
    const h = Math.floor(delta / RELATIVE_TIME_HOUR);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const d = Math.floor(delta / RELATIVE_TIME_DAY);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function formatPendingPermissionLine(
  state: PermissionState,
  now: number,
): string {
  const id = state.id;
  const block = state.lastBlockedFeature;
  if (state.status === "denied" && block) {
    const when = formatRelativeTime(now, block.at);
    return `- ${id}: denied ${when} (${block.app}.${block.action})`;
  }
  if (state.status === "denied") {
    return `- ${id}: denied`;
  }
  if (state.status === "not-determined") {
    return `- ${id}: not-determined`;
  }
  if (state.status === "restricted") {
    const why = state.restrictedReason ?? "restricted";
    return `- ${id}: restricted (${why})`;
  }
  return `- ${id}: ${state.status}`;
}

export function buildPendingPermissionsContext(
  states: PermissionState[],
  now = Date.now(),
): string {
  if (states.length === 0) return "";
  const body = states
    .map((s) => formatPendingPermissionLine(s, now))
    .join("\n");
  return `PENDING PERMISSIONS:\n${body}`;
}

export const pendingPermissionsProvider: Provider = {
  name: "elizaPendingPermissions",
  description:
    "Surfaces permissions blocked or not-yet-granted so the planner can decide whether to re-request.",
  descriptionCompressed: "surface blocked permission for planner",
  dynamic: true,
  position: -5,
  cacheStable: false,
  cacheScope: "turn",

  async get(
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    const registry = resolveRegistry(runtime);
    if (!registry) return { text: "", values: {}, data: {} };

    const pending = registry.pending();
    if (!Array.isArray(pending) || pending.length === 0) {
      return { text: "", values: {}, data: {} };
    }

    const text = buildPendingPermissionsContext(pending);
    return {
      text,
      values: { pendingPermissionCount: pending.length },
      data: {
        pendingPermissions: pending.map((s) => ({
          id: s.id,
          status: s.status,
          feature: s.lastBlockedFeature
            ? `${s.lastBlockedFeature.app}.${s.lastBlockedFeature.action}`
            : undefined,
        })),
      },
    };
  },
};
