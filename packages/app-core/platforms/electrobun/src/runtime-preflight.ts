/**
 * Resolves the desktop runtime topology after verifying persisted external
 * targets. Direct packages recover to their embedded runtime when a previously
 * selected remote agent is unavailable, while explicit env targets and
 * runtime-less cloud-only packages remain authoritative.
 */
import {
  type DesktopRuntimeModeResolution,
  normalizeApiBase,
  type PersistedDeployment,
  resolveDesktopRuntimeMode,
  resolveDesktopRuntimeModeWithDeployment,
} from "./api-base";

const EXTERNAL_REACHABILITY_TIMEOUT_MS = 1_500;

export type ExternalReachabilityProbe = (
  base: string,
  accessToken?: string,
) => Promise<boolean>;

export interface QualifiedExternalAccess {
  origin: string;
  token: string;
}

export interface DesktopRuntimeBootResolution
  extends DesktopRuntimeModeResolution {
  qualifiedAccess?: QualifiedExternalAccess;
  externalReachability?: "verified" | "unavailable";
}

export function resolveQualifiedExternalToken(
  resolution: DesktopRuntimeBootResolution,
  targetBase: string | null | undefined,
): string | undefined {
  const targetOrigin = normalizeApiBase(targetBase ?? undefined);
  return targetOrigin && resolution.qualifiedAccess?.origin === targetOrigin
    ? resolution.qualifiedAccess.token
    : undefined;
}

export function resolveDesktopApiRequestToken(options: {
  resolution: DesktopRuntimeBootResolution;
  targetUrl: string;
  configuredToken?: string | null;
}): string | undefined {
  const configuredToken = options.configuredToken?.trim() || undefined;
  if (options.resolution.mode === "local") {
    return configuredToken;
  }
  if (options.resolution.mode !== "external") {
    return undefined;
  }

  const targetOrigin = normalizeApiBase(options.targetUrl);
  const externalOrigin = normalizeApiBase(
    options.resolution.externalApi.base ?? undefined,
  );
  if (!targetOrigin || !externalOrigin || targetOrigin !== externalOrigin) {
    return undefined;
  }

  return (
    configuredToken ??
    resolveQualifiedExternalToken(options.resolution, options.targetUrl)
  );
}

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
    redirect: "error",
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
      undefined,
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
}): Promise<DesktopRuntimeBootResolution> {
  const { env, deployment, probe = probeExternalAgent } = options;
  const resolved = resolveDesktopRuntimeModeWithDeployment(env, deployment);

  if (
    resolved.mode !== "external" ||
    !resolved.externalApi.base ||
    hasExplicitExternalTarget(env)
  ) {
    return resolved;
  }

  const envOnly = resolveDesktopRuntimeMode(env);
  const token = deployment?.remoteAccessToken?.trim() || undefined;
  if (await probe(resolved.externalApi.base, token)) {
    return token
      ? {
          ...resolved,
          externalReachability: "verified",
          qualifiedAccess: { origin: resolved.externalApi.base, token },
        }
      : { ...resolved, externalReachability: "verified" };
  }

  // A runtime-less package cannot recover to an agent it does not ship. Keep
  // the persisted topology external but unqualified so callers render an
  // unavailable external runtime instead of silently inventing a local one.
  if (envOnly.mode === "disabled") {
    return { ...resolved, externalReachability: "unavailable" };
  }

  return envOnly;
}
