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

export type ExternalReachabilityProbe = (
  base: string,
  accessToken?: string,
) => Promise<boolean>;

function hasExplicitExternalTarget(
  env: Record<string, string | undefined>,
): boolean {
  return (
    resolveDesktopRuntimeMode(env).mode === "external" ||
    Boolean(env.ELIZA_DESKTOP_CLOUD_AGENT_BASE?.trim())
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReadyHealth(body: unknown): boolean {
  return isRecord(body) && body.ready === true;
}

function isReadyElizaStatus(body: unknown): boolean {
  return (
    isRecord(body) &&
    body.state === "running" &&
    body.canRespond === true &&
    typeof body.agentName === "string" &&
    body.agentName.trim().length > 0
  );
}

async function fetchJson(
  url: string,
  signal: AbortSignal,
  accessToken?: string,
): Promise<unknown | null> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const response = await fetch(url, {
    method: "GET",
    headers,
    signal,
  });
  if (response.status !== 200) return null;
  return response.json();
}

export async function probeExternalAgent(
  base: string,
  accessToken?: string,
): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(EXTERNAL_REACHABILITY_TIMEOUT_MS);
    const normalizedBase = base.replace(/\/+$/, "");
    const health = await fetchJson(
      `${normalizedBase}/api/health`,
      signal,
      accessToken,
    );
    if (!isReadyHealth(health)) return false;

    // Public remote health intentionally exposes only `{ ready }`. Pair it
    // with the agent status contract so an unrelated service cannot suppress
    // the embedded runtime merely by answering on the persisted port.
    const status = await fetchJson(
      `${normalizedBase}/api/status`,
      signal,
      accessToken,
    );
    return isReadyElizaStatus(status);
  } catch {
    // error-policy:J1 desktop startup probe converts transport and malformed
    // response failures into the explicit local-recovery decision below.
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

  if (
    await probe(
      resolved.externalApi.base,
      deployment?.remoteAccessToken?.trim() || undefined,
    )
  ) {
    return resolved;
  }

  return envOnly;
}
