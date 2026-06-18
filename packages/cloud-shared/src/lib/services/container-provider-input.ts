/**
 * Build a `CreateContainerInput` for a user-deployed app container (Apps /
 * Product 2), from app-level parameters + sensible defaults.
 *
 * This is the apps-lane counterpart to the agent provisioning path, and it
 * exists to enforce ONE load-bearing invariant as a pure, unit-testable
 * contract: **it never auto-injects `DATABASE_URL`.** The agent path
 * deliberately force-overwrites `DATABASE_URL` with the shared cluster URL
 * *after* spreading caller env (so an agent can't bring its own DB); the apps
 * path must do the opposite — it reads no `process.env`, and forwards only the
 * caller-supplied `environmentVars` verbatim. The per-tenant isolated DSN (a
 * later unit) is passed IN by the caller via `environmentVars`; it is never
 * sourced from the shared environment here.
 */

import type { CreateContainerInput } from "./containers/hetzner-client/types";

/**
 * Defaults for a small stateless web app. All overridable per-call.
 *
 * `cpu` is in ECS/Fargate-style CPU units (1024 = 1 vCPU) — the SAME unit the
 * `containers.cpu` column, `calculateDailyContainerCost`, and the docker
 * `--cpus` flag use. `1024` (= 1 full vCPU) is the floor for a usable web app;
 * the previous `1` was a unit bug (≈0.001 vCPU) that both under-described the
 * allocation to billing and, once `--cpus` is enforced at create time, would
 * throttle the container to a fraction of a core.
 */
export const APP_CONTAINER_DEFAULTS = {
  port: 3000,
  desiredCount: 1,
  cpu: 1024,
  memoryMb: 512,
  healthCheckPath: "/health",
} as const;

export interface ContainerProvisionParams {
  /** Container name (unique within the org/project). */
  name: string;
  /** Project the container belongs to (keys the persistent volume). */
  projectName: string;
  organizationId: string;
  userId: string;
  apiKeyId?: string | null;
  description?: string;
  /** Full image reference, e.g. `ghcr.io/owner/app:tag`. */
  image: string;
  /** App listen port. Default 3000. */
  port?: number;
  /** Replicas (must be 1 on the shared pool). Default 1. */
  desiredCount?: number;
  /** CPU units (1024 = 1 vCPU; billing + docker --cpus). Default 1024. */
  cpu?: number;
  /** Memory MB (`docker run --memory`). Default 512. */
  memoryMb?: number;
  /** Health-check path probed by the cron monitor. Default `/health`. */
  healthCheckPath?: string;
  /**
   * Environment forwarded into the container verbatim. The caller owns this —
   * including any per-tenant `DATABASE_URL`. This builder never adds, removes,
   * or overwrites entries here.
   */
  environmentVars?: Record<string, string>;
  /** Mount a project-scoped persistent volume. Default false. */
  persistVolume?: boolean;
}

/**
 * Pure builder: app params -> `CreateContainerInput`. Applies
 * {@link APP_CONTAINER_DEFAULTS} for any unset field and forwards
 * `environmentVars` unchanged. Reads no ambient environment.
 */
export function buildContainerProvisionInput(
  params: ContainerProvisionParams,
): CreateContainerInput {
  if (!params.name) {
    throw new TypeError("buildContainerProvisionInput: name is required");
  }
  if (!params.projectName) {
    throw new TypeError("buildContainerProvisionInput: projectName is required");
  }
  if (!params.image) {
    throw new TypeError("buildContainerProvisionInput: image is required");
  }
  if (!params.organizationId || !params.userId) {
    throw new TypeError("buildContainerProvisionInput: organizationId and userId are required");
  }

  const input: CreateContainerInput = {
    name: params.name,
    projectName: params.projectName,
    organizationId: params.organizationId,
    userId: params.userId,
    apiKeyId: params.apiKeyId ?? null,
    image: params.image,
    port: params.port ?? APP_CONTAINER_DEFAULTS.port,
    desiredCount: params.desiredCount ?? APP_CONTAINER_DEFAULTS.desiredCount,
    cpu: params.cpu ?? APP_CONTAINER_DEFAULTS.cpu,
    memoryMb: params.memoryMb ?? APP_CONTAINER_DEFAULTS.memoryMb,
    healthCheckPath: params.healthCheckPath ?? APP_CONTAINER_DEFAULTS.healthCheckPath,
  };

  if (params.description !== undefined) {
    input.description = params.description;
  }
  if (params.persistVolume !== undefined) {
    input.persistVolume = params.persistVolume;
  }
  // Forward caller env verbatim — never source DATABASE_URL (or anything) from
  // the ambient/shared environment. Copy so callers can't mutate our output.
  if (params.environmentVars) {
    input.environmentVars = { ...params.environmentVars };
  }

  return input;
}
