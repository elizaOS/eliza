/**
 * Internal contract stamped by local-development launchers. A valid authority
 * marker means persisted Cloud state must not replace the launcher's tuple.
 */

export type DevCloudEnvAuthority =
  | "staging-default"
  | "staging-explicit"
  | "production"
  | "offline"
  | "self-hosted";

const DEV_CLOUD_ENV_AUTHORITIES = new Set<DevCloudEnvAuthority>([
  "staging-default",
  "staging-explicit",
  "production",
  "offline",
  "self-hosted",
]);

export interface DevCloudEnvAuthoritySnapshot {
  readonly authority: DevCloudEnvAuthority;
  readonly values: Readonly<Record<string, string | undefined>>;
}

type MutableEnvironment = Record<string, string | undefined>;

let frozenProcessSnapshot: DevCloudEnvAuthoritySnapshot | undefined;

const DEV_CLOUD_CONTROL_KEYS = new Set([
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_DEV_CLOUD_TARGET",
]);

// These credentials participate in managed-container classification even
// though their historical names do not use a Cloud-specific prefix. Capture
// them with the launcher tuple so an explicit target cannot be reclassified by
// late process.env mutation. They intentionally remain outside
// isCloudAuthorityKey: ELIZA_API_TOKEN also protects local HTTP APIs, so the
// staging-default/offline scrub must not globally erase it.
const DEV_CLOUD_PROVISIONING_CREDENTIAL_KEYS = ["ELIZA_API_TOKEN"] as const;

/**
 * Steward values that can authorize wallet discovery, creation, signing, or
 * trading. Development launchers own these alongside the Cloud tuple: a late
 * config/keychain/runtime merge must never turn ordinary local development
 * into an authenticated money path or redirect an explicit target.
 */
export const DEV_CLOUD_STEWARD_OPERATIONAL_ENV_KEYS = [
  "STEWARD_API_URL",
  "STEWARD_TENANT_ID",
  "STEWARD_AGENT_ID",
  "ELIZA_STEWARD_AGENT_ID",
  "STEWARD_API_KEY",
  "STEWARD_AGENT_TOKEN",
  "STEWARD_TRADE_SESSION_ID",
  "STEWARD_HYPERLIQUID_TRADE_SESSION_ID",
  "STEWARD_POLYMARKET_TRADE_SESSION_ID",
] as const;

const DEV_CLOUD_STEWARD_OPERATIONAL_ENV_KEY_SET = new Set<string>(
  DEV_CLOUD_STEWARD_OPERATIONAL_ENV_KEYS,
);

export type DevCloudStewardOperationalTuple =
  | Readonly<{
      authority: DevCloudEnvAuthority;
      enabled: false;
    }>
  | Readonly<{
      authority: DevCloudEnvAuthority;
      enabled: true;
      apiUrl: string;
      tenantId?: string;
      agentId: string;
      apiKey?: string;
      agentToken?: string;
    }>;

function isStewardOperationalKey(key: string): boolean {
  return DEV_CLOUD_STEWARD_OPERATIONAL_ENV_KEY_SET.has(key.toUpperCase());
}

function isCloudAuthorityKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (DEV_CLOUD_CONTROL_KEYS.has(normalizedKey)) return false;
  return (
    normalizedKey.startsWith("ELIZAOS_CLOUD_") ||
    normalizedKey.startsWith("ELIZA_CLOUD_") ||
    normalizedKey.startsWith("ELIZA_DEV_CLOUD_") ||
    normalizedKey.startsWith("ELIZACLOUD_") ||
    normalizedKey.startsWith("WAIFU_ELIZA_CLOUD_")
  );
}

function isDevCloudProjectionKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  return (
    DEV_CLOUD_CONTROL_KEYS.has(normalizedKey) ||
    DEV_CLOUD_PROVISIONING_CREDENTIAL_KEYS.includes(
      normalizedKey as (typeof DEV_CLOUD_PROVISIONING_CREDENTIAL_KEYS)[number],
    ) ||
    isCloudAuthorityKey(normalizedKey) ||
    isStewardOperationalKey(normalizedKey)
  );
}

function parseAuthority(env: NodeJS.ProcessEnv): DevCloudEnvAuthority | null {
  if (env.ELIZA_DEV_SOURCE !== "1") return null;
  const value = env.ELIZA_DEV_CLOUD_ENV_AUTHORITY?.trim().toLowerCase();
  if (!value || !DEV_CLOUD_ENV_AUTHORITIES.has(value as DevCloudEnvAuthority)) {
    return null;
  }
  return value as DevCloudEnvAuthority;
}

function freezeSnapshot(
  authority: DevCloudEnvAuthority,
  env: NodeJS.ProcessEnv,
): DevCloudEnvAuthoritySnapshot {
  const activationBlocked =
    authority === "staging-default" || authority === "offline";
  const keys = new Set([
    ...Object.keys(env).filter(isCloudAuthorityKey),
    ...DEV_CLOUD_CONTROL_KEYS,
    ...DEV_CLOUD_PROVISIONING_CREDENTIAL_KEYS,
    ...DEV_CLOUD_STEWARD_OPERATIONAL_ENV_KEYS,
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZAOS_CLOUD_BASE_URL",
    "ELIZAOS_CLOUD_SERVICE_KEY",
    "ELIZA_CLOUD_SERVICE_KEY",
    "ELIZA_CLOUD_WRITE_BASE_URL",
  ]);
  const values = Object.fromEntries(
    [...keys].map((key) => {
      if (key === "ELIZA_DEV_SOURCE") return [key, "1"];
      if (key === "ELIZA_DEV_CLOUD_ENV_AUTHORITY") {
        return [key, authority];
      }
      if (key === "ELIZA_DEV_CLOUD_TARGET") return [key, env[key]];
      if (key === "ELIZAOS_CLOUD_BASE_URL") {
        if (authority === "production") {
          return [key, "https://api.eliza.app/api/v1"];
        }
        if (authority !== "self-hosted") {
          return [key, "https://api-staging.eliza.app/api/v1"];
        }
      }
      if (
        activationBlocked &&
        (isCloudAuthorityKey(key) || isStewardOperationalKey(key))
      ) {
        return [key, ""];
      }
      return [key, env[key]];
    }),
  );
  return Object.freeze({
    authority,
    values: Object.freeze(values),
  });
}

/** Ignore an authority marker outside a launcher-owned development process. */
export function resolveDevCloudEnvAuthority(
  env: NodeJS.ProcessEnv = process.env,
): DevCloudEnvAuthority | null {
  if (env === process.env && frozenProcessSnapshot) {
    return frozenProcessSnapshot.authority;
  }
  const authority = parseAuthority(env);
  if (!authority) return null;
  if (env === process.env && !frozenProcessSnapshot) {
    frozenProcessSnapshot = freezeSnapshot(authority, env);
  }
  return env === process.env
    ? (frozenProcessSnapshot?.authority ?? authority)
    : authority;
}

/** Return the process-lifetime tuple captured on the first authority read. */
export function captureDevCloudEnvAuthoritySnapshot(
  env: NodeJS.ProcessEnv = process.env,
): DevCloudEnvAuthoritySnapshot | null {
  const authority = resolveDevCloudEnvAuthority(env);
  if (!authority) return null;
  if (env === process.env) return frozenProcessSnapshot ?? null;
  return freezeSnapshot(authority, env);
}

/**
 * Project the frozen launcher tuple into a child-process environment.
 *
 * A restarted child is a fresh JavaScript process, so it cannot inherit the
 * parent's in-memory snapshot. Remove every authority-owned value from the
 * late mutable environment first, then restore only the values captured by
 * the parent. Unrelated process settings remain untouched.
 */
export function applyDevCloudAuthoritySnapshotToEnv(
  target: MutableEnvironment,
  snapshot: DevCloudEnvAuthoritySnapshot | null = captureDevCloudEnvAuthoritySnapshot(),
): boolean {
  if (!snapshot) return false;

  for (const key of Object.keys(target)) {
    if (isDevCloudProjectionKey(key)) delete target[key];
  }
  for (const [key, value] of Object.entries(snapshot.values)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
  return true;
}

/** Read a value from the immutable launcher tuple, never mutable live env. */
export function resolveDevCloudAuthorityEnvValue(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const snapshot = captureDevCloudEnvAuthoritySnapshot(env);
  if (!snapshot) return env[key];
  if (isStewardOperationalKey(key)) {
    const stewardTuple = resolveDevCloudStewardOperationalTuple(env);
    if (stewardTuple && !stewardTuple.enabled) return "";
  }
  if (
    (snapshot.authority === "staging-default" ||
      snapshot.authority === "offline") &&
    isCloudAuthorityKey(key)
  ) {
    return key === "ELIZAOS_CLOUD_BASE_URL"
      ? "https://api-staging.eliza.app/api/v1"
      : "";
  }
  return snapshot.values[key];
}

function trimmedSnapshotValue(
  snapshot: DevCloudEnvAuthoritySnapshot,
  key: (typeof DEV_CLOUD_STEWARD_OPERATIONAL_ENV_KEYS)[number],
): string | undefined {
  const value = snapshot.values[key]?.trim();
  return value || undefined;
}

function usableSnapshotCredential(
  snapshot: DevCloudEnvAuthoritySnapshot,
  key: "STEWARD_API_KEY" | "STEWARD_AGENT_TOKEN",
): string | undefined {
  const value = trimmedSnapshotValue(snapshot, key);
  if (
    !value ||
    value.toUpperCase() === "[REDACTED]" ||
    value.toLowerCase().startsWith("vault://")
  ) {
    return undefined;
  }
  return value;
}

function isSecureStewardApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Resolve the immutable launch-authorized Steward connection, when a
 * development launcher owns the process. A null result means there is no dev
 * authority and legacy consumers may use their normal sources. An authority
 * result with `enabled: false` is an explicit fail-closed decision.
 */
export function resolveDevCloudStewardOperationalTuple(
  env: NodeJS.ProcessEnv = process.env,
): DevCloudStewardOperationalTuple | null {
  const snapshot = captureDevCloudEnvAuthoritySnapshot(env);
  if (!snapshot) return null;
  if (
    snapshot.authority === "staging-default" ||
    snapshot.authority === "offline"
  ) {
    return Object.freeze({ authority: snapshot.authority, enabled: false });
  }

  const apiUrl = trimmedSnapshotValue(snapshot, "STEWARD_API_URL");
  const primaryAgentId = trimmedSnapshotValue(snapshot, "STEWARD_AGENT_ID");
  const aliasAgentId = trimmedSnapshotValue(snapshot, "ELIZA_STEWARD_AGENT_ID");
  const agentId = primaryAgentId ?? aliasAgentId;
  const tenantId = trimmedSnapshotValue(snapshot, "STEWARD_TENANT_ID");
  const apiKey = usableSnapshotCredential(snapshot, "STEWARD_API_KEY");
  const agentToken = usableSnapshotCredential(snapshot, "STEWARD_AGENT_TOKEN");
  const agentIdsConflict = Boolean(
    primaryAgentId && aliasAgentId && primaryAgentId !== aliasAgentId,
  );
  const hasAuthorizedCredential = Boolean(agentToken || (apiKey && tenantId));

  if (
    !apiUrl ||
    !isSecureStewardApiUrl(apiUrl) ||
    !agentId ||
    agentIdsConflict ||
    !hasAuthorizedCredential ||
    (apiKey && !tenantId)
  ) {
    return Object.freeze({ authority: snapshot.authority, enabled: false });
  }

  return Object.freeze({
    authority: snapshot.authority,
    enabled: true,
    apiUrl,
    ...(tenantId ? { tenantId } : {}),
    agentId,
    ...(apiKey ? { apiKey } : {}),
    ...(agentToken ? { agentToken } : {}),
  });
}

/** @internal Test isolation for the process-lifetime launch snapshot. */
export function resetDevCloudEnvAuthorityForTests(): void {
  frozenProcessSnapshot = undefined;
}
