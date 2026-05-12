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
   *  controller proxies to. Cloud/public bases are rejected here too so
   *  stale or hand-edited config cannot turn remote mode into cloud mode. */
  remoteApiBase: string | null;
  /** Populated when a remote target was configured but rejected. */
  remoteApiBaseError: string | null;
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
    const remoteApiBase = deploymentTarget.remoteApiBase?.trim() || null;
    const remoteValidation = validateRemoteApiBase(remoteApiBase);
    let validatedRemoteApiBase: string | null = null;
    let remoteApiBaseError: string | null = null;
    if ("href" in remoteValidation) {
      validatedRemoteApiBase = remoteValidation.href;
    } else {
      remoteApiBaseError = remoteValidation.error;
    }
    return {
      mode: "remote",
      deploymentTarget,
      remoteApiBase: validatedRemoteApiBase,
      remoteApiBaseError,
      remoteAccessToken: deploymentTarget.remoteAccessToken?.trim() || null,
    };
  }

  if (deploymentTarget?.runtime === "cloud") {
    return {
      mode: "cloud",
      deploymentTarget,
      remoteApiBase: null,
      remoteApiBaseError: null,
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
    remoteApiBaseError: null,
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

export interface RemoteApiBaseValidationOk {
  ok: true;
  href: string;
}

export interface RemoteApiBaseValidationErr {
  ok: false;
  error: string;
}

export type RemoteApiBaseValidation =
  | RemoteApiBaseValidationOk
  | RemoteApiBaseValidationErr;

/**
 * Remote mode is a thin controller for another local/private Eliza instance,
 * never for Eliza Cloud or a public model API. Accept loopback, private
 * RFC1918/CGNAT/link-local hosts, and .local mDNS names.
 */
export function validateRemoteApiBase(
  value: string | null | undefined,
): RemoteApiBaseValidation {
  const raw = value?.trim();
  if (!raw) {
    return { ok: false, error: "Remote target not configured" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "Remote target must be a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Remote target must use http or https" };
  }
  if (!isLocalRemoteHost(url.hostname)) {
    return {
      ok: false,
      error:
        "Remote mode can only target loopback, .local, or private-network Eliza instances",
    };
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return { ok: true, href: url.toString() };
}

export function isLocalRemoteHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  if (host === "::1") return true;
  if (host.startsWith("fe80:")) return true;

  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (!octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
