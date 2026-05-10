/**
 * Canonical runtime-mode resolver for the AGENTS.md §1/§5 contract.
 *
 * Eliza ships in three top-level runtime shapes — `local`, `cloud`, `remote`
 * — plus a `local-only` sub-state of `local` that hides every cloud-routed
 * surface. This module is the single source of truth that the API layer,
 * the local-inference service, and the UI bridge all read from.
 *
 * Resolution order (highest precedence first):
 *   1. `config.deploymentTarget.runtime` — the persisted onboarding choice.
 *   2. (local only) `config.cloud.enabled === false` collapses `local` to
 *      `local-only`.
 *
 * The `RUNTIME_EXECUTION_MODE` env var family in
 * `@elizaos/shared/config/runtime-mode.ts` is a *different* concept (sandbox
 * vs. yolo execution policy for shell tools); do not conflate.
 */

import { loadElizaConfig } from "@elizaos/agent";
import {
  type DeploymentTargetConfig,
  normalizeDeploymentTargetConfig,
} from "@elizaos/shared";
import { z } from "zod";

export const RUNTIME_MODES = [
  "local",
  "local-only",
  "cloud",
  "remote",
] as const;

export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export interface RuntimeModeSnapshot {
  mode: RuntimeMode;
  deploymentTarget: DeploymentTargetConfig | null;
  /** Present iff `mode === "remote"`. The local-instance HTTP base the
   *  controller proxies to. Cloud bases are rejected upstream during
   *  onboarding (see `onboarding.ts`). */
  remoteApiBase: string | null;
  remoteAccessToken: string | null;
}

// Strong schema for the slice of `eliza.json` this resolver consumes.
// The shared `DeploymentTargetConfig` is already validated by
// `normalizeDeploymentTargetConfig`, so we keep that field as `unknown`
// and let the normalizer enforce the contract. The `cloud` block is the
// only opaque-typed surface this module needs to read.
const RuntimeModeConfigSchema = z
  .object({
    deploymentTarget: z.unknown().optional(),
    cloud: z
      .object({
        enabled: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

type RuntimeModeConfigShape = z.infer<typeof RuntimeModeConfigSchema>;

function parseRuntimeModeConfig(
  config: unknown,
): RuntimeModeConfigShape | null {
  if (config == null) return null;
  const parsed = RuntimeModeConfigSchema.safeParse(config);
  // Unknown shape ⇒ behave as "no config" so the resolver returns the
  // default `local` mode rather than throwing. Writers that produce
  // garbage are caught at their own boundary; the resolver stays pure.
  return parsed.success ? parsed.data : null;
}

/**
 * Pure resolver — no I/O. Use this when you already hold the config object
 * (route handlers usually do) so the caller picks the load strategy.
 */
export function resolveRuntimeMode(
  config: RuntimeModeConfigShape | null | undefined,
): RuntimeModeSnapshot {
  const deploymentTarget = normalizeDeploymentTargetConfig(
    config?.deploymentTarget,
  );

  if (deploymentTarget?.runtime === "remote") {
    return {
      mode: "remote",
      deploymentTarget,
      remoteApiBase: deploymentTarget.remoteApiBase?.trim() || null,
      remoteAccessToken: deploymentTarget.remoteAccessToken?.trim() || null,
    };
  }

  if (deploymentTarget?.runtime === "cloud") {
    return {
      mode: "cloud",
      deploymentTarget,
      remoteApiBase: null,
      remoteAccessToken: null,
    };
  }

  // Default and explicit `local` — `cloud.enabled === false` collapses
  // to `local-only`. The strong schema above means we can read the
  // field directly without a `typeof === "object"` guard.
  const cloudExplicitlyDisabled = config?.cloud?.enabled === false;

  return {
    mode: cloudExplicitlyDisabled ? "local-only" : "local",
    deploymentTarget: deploymentTarget ?? null,
    remoteApiBase: null,
    remoteAccessToken: null,
  };
}

/**
 * Disk-backed resolver. Reads `eliza.json` from the canonical config path.
 * Use this from request handlers — `loadElizaConfig` is already memoised
 * for the lifetime of the agent runtime.
 */
export function getRuntimeMode(): RuntimeMode {
  return resolveRuntimeMode(parseRuntimeModeConfig(loadElizaConfig())).mode;
}

/** Disk-backed snapshot. */
export function getRuntimeModeSnapshot(): RuntimeModeSnapshot {
  return resolveRuntimeMode(parseRuntimeModeConfig(loadElizaConfig()));
}

/** True for both `local` and `local-only`. */
export function isLocalRuntime(mode: RuntimeMode): boolean {
  return mode === "local" || mode === "local-only";
}
