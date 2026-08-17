/**
 * Resolves the desktop runtime topology after verifying persisted external
 * targets. Direct packages recover to their embedded runtime when a previously
 * selected remote agent is unavailable, while explicit env targets and
 * runtime-less cloud-only packages remain authoritative.
 */
import {
  type DesktopRuntimeModeResolution,
  type PersistedDeployment,
  resolveDesktopRuntimeMode,
  resolveDesktopRuntimeModeWithDeployment,
} from "./api-base";

const EXTERNAL_REACHABILITY_TIMEOUT_MS = 1_500;

export type ExternalReachabilityProbe = (base: string) => Promise<boolean>;

function hasExplicitExternalTarget(
  env: Record<string, string | undefined>,
): boolean {
  return (
    resolveDesktopRuntimeMode(env).mode === "external" ||
    Boolean(env.ELIZA_DESKTOP_CLOUD_AGENT_BASE?.trim())
  );
}

export async function probeExternalAgent(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/health`, {
      method: "GET",
      signal: AbortSignal.timeout(EXTERNAL_REACHABILITY_TIMEOUT_MS),
    });
    // Authentication failures still prove that the selected server exists.
    return response.status < 500;
  } catch {
    // error-policy:J1 desktop startup reachability boundary converts a failed
    // transport into the explicit local-recovery decision below.
    return false;
  }
}

export async function resolveDesktopRuntimeForBoot(options: {
  env: Record<string, string | undefined>;
  deployment: PersistedDeployment | null;
  probe?: ExternalReachabilityProbe;
}): Promise<DesktopRuntimeModeResolution> {
  const { env, deployment, probe = probeExternalAgent } = options;
  const resolved = resolveDesktopRuntimeModeWithDeployment(env, deployment);

  if (
    resolved.mode !== "external" ||
    !resolved.externalApi.base ||
    hasExplicitExternalTarget(env)
  ) {
    return resolved;
  }

  // A runtime-less package cannot recover to an agent it does not ship.
  const envOnly = resolveDesktopRuntimeMode(env);
  if (envOnly.mode === "disabled") {
    return resolved;
  }

  if (await probe(resolved.externalApi.base)) {
    return resolved;
  }

  return envOnly;
}
