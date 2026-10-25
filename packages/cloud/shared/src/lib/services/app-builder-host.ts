/**
 * Build-from-repo isolation gate (Apps / Product 2) — pure config logic that
 * decides WHETHER and WHERE an untrusted user Dockerfile may be built.
 *
 * BLOCKER #6: building an untrusted Dockerfile runs RUN steps + BuildKit on some
 * dockerd. If that dockerd also hosts other tenants' live containers, a malicious
 * Dockerfile (docker-socket access, cache poisoning, daemon API) can compromise
 * co-tenants or the node. The throwaway-isolated-builder (see app-build-cmd.ts)
 * keeps the build off the host's shared build cache/image store; this module is
 * the second half: refuse to build unless explicitly armed AND an isolated
 * builder host is available, preferring a DEDICATED builder distinct from any
 * node hosting tenant containers.
 *
 * Pure (only reads `containersEnv` + the injected node selector), so the gate is
 * unit-testable WITHOUT the DB/store/SSH chain the executor composition pulls in.
 */

import { containersEnv } from "../config/containers-env";

/**
 * Resolve the host that runs UNTRUSTED app builds — a DEDICATED builder host
 * distinct from any node hosting tenant containers, if one is configured.
 *
 * Prefers `APPS_BUILDS_HOST` (a dedicated builder). Falls back to the runtime
 * node (`selectRuntimeNode()`) ONLY when the operator explicitly opts in via
 * `APPS_BUILD_ON_RUNTIME_NODE=1`, accepting the residual blast radius the
 * throwaway-isolated-builder narrows but does not eliminate. Returns null (no
 * builder → build-from-repo stays off) otherwise.
 *
 * @param selectRuntimeNode resolves the runtime container node host (or null).
 */
export function selectBuilderHost(selectRuntimeNode: () => string | null): string | null {
  const dedicated = containersEnv.buildsHost();
  if (dedicated) return dedicated;
  if (containersEnv.buildOnRuntimeNodeAllowed()) return selectRuntimeNode();
  return null;
}

export interface BuilderArmDecision {
  /** True only when an untrusted build may run; `host` is then non-null. */
  armed: boolean;
  /** The resolved builder host when armed; null otherwise. */
  host: string | null;
  /** True when `host` is a dedicated builder (not the runtime node). */
  dedicated: boolean;
  /** Operator-facing reason the build is not armed (for logging). */
  reason?: "backend-disabled" | "not-armed" | "no-isolated-host";
}

/**
 * Decide whether build-from-repo is armed and on which isolated host. Pure: all
 * IO (`appsContainersEnabled`, node selection) is injected, so the security gate
 * is fully unit-testable without the runtime fleet.
 *
 * Armed requires ALL of:
 *   1. the container backend is configured (`backendEnabled`),
 *   2. build-from-repo is explicitly armed (`APPS_BUILD_FROM_REPO_ENABLED=1`),
 *   3. an isolated builder host resolves (dedicated, or runtime-node opt-in).
 */
export function decideBuilderArming(deps: {
  backendEnabled: boolean;
  selectRuntimeNode: () => string | null;
}): BuilderArmDecision {
  if (!deps.backendEnabled) {
    return { armed: false, host: null, dedicated: false, reason: "backend-disabled" };
  }
  if (!containersEnv.buildFromRepoEnabled()) {
    return { armed: false, host: null, dedicated: false, reason: "not-armed" };
  }
  const host = selectBuilderHost(deps.selectRuntimeNode);
  if (!host) {
    return { armed: false, host: null, dedicated: false, reason: "no-isolated-host" };
  }
  return { armed: true, host, dedicated: host !== deps.selectRuntimeNode() };
}
