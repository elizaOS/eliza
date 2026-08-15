/**
 * Validates and enforces the standalone gateway's Discord DM-policy assignment state.
 *
 * The inner policy semantics mirror cloud-shared, while the explicit envelope
 * prevents missing or malformed assignment data from bypassing the gate before
 * the in-worker versus dedicated route choice.
 */

const DISCORD_SNOWFLAKE_PATTERN = /^\d{15,20}$/;

export interface DiscordConnectionDmMetadata {
  dmPolicy?: "open" | "disabled" | "allowlist" | "pairing";
  ownerDiscordUserId?: string;
  ownerDiscordUserIds?: string[];
  dmAllowFrom?: string[];
}

export type DiscordConnectionDmPolicyState =
  | { status: "valid"; metadata: DiscordConnectionDmMetadata }
  | { status: "invalid" };

export const INVALID_DISCORD_DM_POLICY_STATE: DiscordConnectionDmPolicyState =
  Object.freeze({ status: "invalid" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDmPolicy(
  value: unknown,
): value is NonNullable<DiscordConnectionDmMetadata["dmPolicy"]> {
  return (
    value === "open" ||
    value === "disabled" ||
    value === "allowlist" ||
    value === "pairing"
  );
}

function isSnowflakeArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "string" && DISCORD_SNOWFLAKE_PATTERN.test(entry),
    )
  );
}

/** Normalize the untrusted assignment envelope; every malformed shape is invalid. */
export function parseDiscordConnectionDmPolicyState(
  value: unknown,
): DiscordConnectionDmPolicyState {
  if (!isRecord(value)) return INVALID_DISCORD_DM_POLICY_STATE;
  if (value.status === "invalid") return INVALID_DISCORD_DM_POLICY_STATE;
  if (value.status !== "valid" || !isRecord(value.metadata)) {
    return INVALID_DISCORD_DM_POLICY_STATE;
  }

  const raw = value.metadata;
  if (raw.dmPolicy !== undefined && !isDmPolicy(raw.dmPolicy)) {
    return INVALID_DISCORD_DM_POLICY_STATE;
  }
  if (
    raw.ownerDiscordUserId !== undefined &&
    (typeof raw.ownerDiscordUserId !== "string" ||
      !DISCORD_SNOWFLAKE_PATTERN.test(raw.ownerDiscordUserId))
  ) {
    return INVALID_DISCORD_DM_POLICY_STATE;
  }
  if (
    raw.ownerDiscordUserIds !== undefined &&
    !isSnowflakeArray(raw.ownerDiscordUserIds)
  ) {
    return INVALID_DISCORD_DM_POLICY_STATE;
  }
  if (raw.dmAllowFrom !== undefined && !isSnowflakeArray(raw.dmAllowFrom)) {
    return INVALID_DISCORD_DM_POLICY_STATE;
  }

  return {
    status: "valid",
    metadata: {
      ...(raw.dmPolicy === undefined ? {} : { dmPolicy: raw.dmPolicy }),
      ...(raw.ownerDiscordUserId === undefined
        ? {}
        : { ownerDiscordUserId: raw.ownerDiscordUserId }),
      ...(raw.ownerDiscordUserIds === undefined
        ? {}
        : { ownerDiscordUserIds: raw.ownerDiscordUserIds }),
      ...(raw.dmAllowFrom === undefined
        ? {}
        : { dmAllowFrom: raw.dmAllowFrom }),
    },
  };
}

/** Decide whether a direct-message sender passes the validated connection policy. */
export function isDmSenderAllowed(
  state: DiscordConnectionDmPolicyState | undefined,
  authorId: string,
): boolean {
  if (state?.status !== "valid") return false;
  const metadata = state.metadata;
  const dmPolicy = metadata.dmPolicy ?? "open";
  if (dmPolicy === "open") return true;
  if (dmPolicy === "disabled") return false;
  const allowed = new Set<string>(metadata.ownerDiscordUserIds ?? []);
  if (metadata.ownerDiscordUserId) allowed.add(metadata.ownerDiscordUserId);
  if (dmPolicy === "allowlist") {
    for (const id of metadata.dmAllowFrom ?? []) allowed.add(id);
  }
  return allowed.has(authorId);
}
