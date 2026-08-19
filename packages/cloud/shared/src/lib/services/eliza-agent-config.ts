// Coordinates cloud service eliza agent config behavior behind route handlers.
export const AGENT_INTERNAL_CONFIG_PREFIX = "__agent";
export const AGENT_CHARACTER_OWNERSHIP_KEY = "__agentCharacterOwnership";
export const AGENT_REUSE_EXISTING_CHARACTER = "reuse-existing";
export const AGENT_MANAGED_DISCORD_KEY = "__agentManagedDiscord";
export const AGENT_MANAGED_DISCORD_GATEWAY_KEY = "__agentManagedDiscordGateway";
export const AGENT_MANAGED_GITHUB_KEY = "__agentManagedGithub";
/**
 * Server-set marker on a DEDICATED agent minted by the shared→dedicated tier
 * upgrade (#15355): records the shared source agent's id so a retried upgrade
 * reattaches to the in-flight migration target instead of minting a second
 * dedicated agent. Lives in the reserved `__agent` namespace, so caller input
 * can never forge it (stripReservedElizaConfigKeys drops it at every create).
 */
export const AGENT_UPGRADED_FROM_KEY = "__agentUpgradedFrom";
/** Server-owned pending request retained across an upgrade tab/device handoff. */
export const AGENT_UPGRADE_CONTINUATION_KEY = "__agentUpgradeContinuation";
export const AGENT_PERSONAL_CUTOVER_KEY = "__agentPersonalCutover";

export interface PersonalElizaCutover {
  mode: "dedicated";
  sourceAgentId: string;
  conversationId: string;
  cutoverToken: string;
  sharedMessageCount: number;
  sharedScheduledTaskCount: number;
  sharedTodoCount: number;
  sharedTodoMutationCount: number;
  sharedTodoDigest: string | null;
  activatedAt: string;
}

/** The shared source agent id a dedicated tier-upgrade target was minted from, if any. */
export function readUpgradedFromAgentId(
  agentConfig?: Record<string, unknown> | null,
): string | null {
  const value = agentConfig?.[AGENT_UPGRADED_FROM_KEY];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Read the server-owned marker that makes a healthy Dedicated target authoritative. */
export function readPersonalElizaCutover(
  agentConfig?: Record<string, unknown> | null,
): PersonalElizaCutover | null {
  const value = asRecord(agentConfig?.[AGENT_PERSONAL_CUTOVER_KEY]);
  const hasSharedTodoCount = value?.sharedTodoCount !== undefined;
  const hasSharedTodoMutationCount = value?.sharedTodoMutationCount !== undefined;
  const hasSharedTodoDigest = value?.sharedTodoDigest !== undefined;
  if (
    value?.mode !== "dedicated" ||
    typeof value.sourceAgentId !== "string" ||
    !value.sourceAgentId.trim() ||
    typeof value.conversationId !== "string" ||
    !value.conversationId.trim() ||
    typeof value.cutoverToken !== "string" ||
    !value.cutoverToken.trim() ||
    typeof value.sharedMessageCount !== "number" ||
    !Number.isInteger(value.sharedMessageCount) ||
    value.sharedMessageCount < 0 ||
    (value.sharedScheduledTaskCount !== undefined &&
      (typeof value.sharedScheduledTaskCount !== "number" ||
        !Number.isInteger(value.sharedScheduledTaskCount) ||
        value.sharedScheduledTaskCount < 0)) ||
    (value.sharedTodoCount !== undefined &&
      (typeof value.sharedTodoCount !== "number" ||
        !Number.isSafeInteger(value.sharedTodoCount) ||
        value.sharedTodoCount < 0)) ||
    (value.sharedTodoMutationCount !== undefined &&
      (typeof value.sharedTodoMutationCount !== "number" ||
        !Number.isSafeInteger(value.sharedTodoMutationCount) ||
        value.sharedTodoMutationCount < 0)) ||
    (value.sharedTodoDigest !== undefined &&
      (typeof value.sharedTodoDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.sharedTodoDigest))) ||
    hasSharedTodoCount !== hasSharedTodoDigest ||
    (hasSharedTodoMutationCount && !hasSharedTodoCount) ||
    typeof value.activatedAt !== "string" ||
    !value.activatedAt.trim()
  ) {
    return null;
  }
  return {
    mode: "dedicated",
    sourceAgentId: value.sourceAgentId,
    conversationId: value.conversationId,
    cutoverToken: value.cutoverToken,
    sharedMessageCount: value.sharedMessageCount,
    sharedScheduledTaskCount: value.sharedScheduledTaskCount ?? 0,
    sharedTodoCount: value.sharedTodoCount ?? 0,
    sharedTodoMutationCount: value.sharedTodoMutationCount ?? 0,
    sharedTodoDigest: value.sharedTodoDigest ?? null,
    activatedAt: value.activatedAt,
  };
}

export interface ManagedAgentDiscordBinding {
  mode: "cloud-managed";
  applicationId?: string;
  guildId: string;
  guildName: string;
  adminDiscordUserId: string;
  adminDiscordUsername: string;
  adminDiscordDisplayName?: string;
  adminDiscordAvatarUrl?: string;
  adminElizaUserId: string;
  botNickname?: string;
  connectedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cloneAgentConfig(agentConfig?: Record<string, unknown> | null): Record<string, unknown> {
  return asRecord(agentConfig) ? { ...agentConfig } : {};
}

export function stripReservedElizaConfigKeys(
  agentConfig?: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!agentConfig) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(agentConfig).filter(
      ([key]) => !key.toLowerCase().startsWith(AGENT_INTERNAL_CONFIG_PREFIX),
    ),
  );
}

export function withReusedElizaCharacterOwnership(
  agentConfig?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    ...stripReservedElizaConfigKeys(agentConfig),
    [AGENT_CHARACTER_OWNERSHIP_KEY]: AGENT_REUSE_EXISTING_CHARACTER,
  };
}

export function reusesExistingElizaCharacter(
  agentConfig?: Record<string, unknown> | null,
): boolean {
  return agentConfig?.[AGENT_CHARACTER_OWNERSHIP_KEY] === AGENT_REUSE_EXISTING_CHARACTER;
}

export function readManagedAgentDiscordBinding(
  agentConfig?: Record<string, unknown> | null,
): ManagedAgentDiscordBinding | null {
  const binding = asRecord(agentConfig?.[AGENT_MANAGED_DISCORD_KEY]);
  if (!binding) {
    return null;
  }

  const guildId = typeof binding.guildId === "string" ? binding.guildId.trim() : "";
  const guildName = typeof binding.guildName === "string" ? binding.guildName.trim() : "";
  const adminDiscordUserId =
    typeof binding.adminDiscordUserId === "string" ? binding.adminDiscordUserId.trim() : "";
  const adminDiscordUsername =
    typeof binding.adminDiscordUsername === "string" ? binding.adminDiscordUsername.trim() : "";
  const adminElizaUserId =
    typeof binding.adminElizaUserId === "string" ? binding.adminElizaUserId.trim() : "";
  const connectedAt = typeof binding.connectedAt === "string" ? binding.connectedAt.trim() : "";

  if (!guildId || !guildName || !adminDiscordUserId || !adminDiscordUsername || !adminElizaUserId) {
    return null;
  }

  return {
    mode: "cloud-managed",
    guildId,
    guildName,
    adminDiscordUserId,
    adminDiscordUsername,
    adminElizaUserId,
    connectedAt: connectedAt || new Date(0).toISOString(),
    ...(typeof binding.applicationId === "string" && binding.applicationId.trim()
      ? { applicationId: binding.applicationId.trim() }
      : {}),
    ...(typeof binding.adminDiscordDisplayName === "string" &&
    binding.adminDiscordDisplayName.trim()
      ? { adminDiscordDisplayName: binding.adminDiscordDisplayName.trim() }
      : {}),
    ...(typeof binding.adminDiscordAvatarUrl === "string" && binding.adminDiscordAvatarUrl.trim()
      ? { adminDiscordAvatarUrl: binding.adminDiscordAvatarUrl.trim() }
      : {}),
    ...(typeof binding.botNickname === "string" && binding.botNickname.trim()
      ? { botNickname: binding.botNickname.trim() }
      : {}),
  };
}

export function withManagedAgentDiscordBinding(
  agentConfig: Record<string, unknown> | null | undefined,
  binding: ManagedAgentDiscordBinding,
): Record<string, unknown> {
  const next = cloneAgentConfig(agentConfig);
  next[AGENT_MANAGED_DISCORD_KEY] = {
    mode: "cloud-managed",
    guildId: binding.guildId,
    guildName: binding.guildName,
    adminDiscordUserId: binding.adminDiscordUserId,
    adminDiscordUsername: binding.adminDiscordUsername,
    adminElizaUserId: binding.adminElizaUserId,
    connectedAt: binding.connectedAt,
    ...(binding.applicationId ? { applicationId: binding.applicationId } : {}),
    ...(binding.adminDiscordDisplayName
      ? { adminDiscordDisplayName: binding.adminDiscordDisplayName }
      : {}),
    ...(binding.adminDiscordAvatarUrl
      ? { adminDiscordAvatarUrl: binding.adminDiscordAvatarUrl }
      : {}),
    ...(binding.botNickname ? { botNickname: binding.botNickname } : {}),
  };
  return next;
}

export function withoutManagedAgentDiscordBinding(
  agentConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = cloneAgentConfig(agentConfig);
  delete next[AGENT_MANAGED_DISCORD_KEY];
  return next;
}

export interface ManagedAgentDiscordGateway {
  mode: "shared-gateway";
  createdAt: string;
}

export function readManagedAgentDiscordGateway(
  agentConfig?: Record<string, unknown> | null,
): ManagedAgentDiscordGateway | null {
  const gateway = asRecord(agentConfig?.[AGENT_MANAGED_DISCORD_GATEWAY_KEY]);
  if (!gateway) {
    return null;
  }

  const mode = typeof gateway.mode === "string" ? gateway.mode.trim() : "";
  if (mode !== "shared-gateway") {
    return null;
  }

  const createdAt = typeof gateway.createdAt === "string" ? gateway.createdAt.trim() : "";

  return {
    mode: "shared-gateway",
    createdAt: createdAt || new Date(0).toISOString(),
  };
}

export function withManagedAgentDiscordGateway(
  agentConfig: Record<string, unknown> | null | undefined,
  gateway: ManagedAgentDiscordGateway = {
    mode: "shared-gateway",
    createdAt: new Date().toISOString(),
  },
): Record<string, unknown> {
  const next = cloneAgentConfig(agentConfig);
  next[AGENT_MANAGED_DISCORD_GATEWAY_KEY] = {
    mode: "shared-gateway",
    createdAt: gateway.createdAt,
  };
  return next;
}

// --- GitHub managed binding ---

export type ManagedAgentGithubMode = "cloud-managed" | "shared-owner";

export interface ManagedAgentGithubBinding {
  mode: ManagedAgentGithubMode;
  connectionId: string;
  githubUserId: string;
  githubUsername: string;
  githubDisplayName?: string;
  githubAvatarUrl?: string;
  githubEmail?: string;
  scopes: string[];
  adminElizaUserId: string;
  connectedAt: string;
  connectionRole?: "owner" | "agent";
  source?: "platform_credentials" | "secrets";
}

export function readManagedAgentGithubBinding(
  agentConfig?: Record<string, unknown> | null,
): ManagedAgentGithubBinding | null {
  const binding = asRecord(agentConfig?.[AGENT_MANAGED_GITHUB_KEY]);
  if (!binding) {
    return null;
  }

  const connectionId = typeof binding.connectionId === "string" ? binding.connectionId.trim() : "";
  const githubUserId = typeof binding.githubUserId === "string" ? binding.githubUserId.trim() : "";
  const githubUsername =
    typeof binding.githubUsername === "string" ? binding.githubUsername.trim() : "";
  const adminElizaUserId =
    typeof binding.adminElizaUserId === "string" ? binding.adminElizaUserId.trim() : "";
  const connectedAt = typeof binding.connectedAt === "string" ? binding.connectedAt.trim() : "";
  const mode =
    binding.mode === "shared-owner" || binding.mode === "cloud-managed"
      ? binding.mode
      : "cloud-managed";
  const connectionRole =
    binding.connectionRole === "owner" || binding.connectionRole === "agent"
      ? binding.connectionRole
      : undefined;
  const source =
    binding.source === "platform_credentials" || binding.source === "secrets"
      ? binding.source
      : undefined;

  if (!connectionId || !githubUserId || !githubUsername || !adminElizaUserId) {
    return null;
  }

  return {
    mode,
    connectionId,
    githubUserId,
    githubUsername,
    adminElizaUserId,
    connectedAt: connectedAt || new Date(0).toISOString(),
    scopes: Array.isArray(binding.scopes) ? binding.scopes : [],
    ...(connectionRole ? { connectionRole } : {}),
    ...(source ? { source } : {}),
    ...(typeof binding.githubDisplayName === "string" && binding.githubDisplayName.trim()
      ? { githubDisplayName: binding.githubDisplayName.trim() }
      : {}),
    ...(typeof binding.githubAvatarUrl === "string" && binding.githubAvatarUrl.trim()
      ? { githubAvatarUrl: binding.githubAvatarUrl.trim() }
      : {}),
    ...(typeof binding.githubEmail === "string" && binding.githubEmail.trim()
      ? { githubEmail: binding.githubEmail.trim() }
      : {}),
  };
}

export function withManagedAgentGithubBinding(
  agentConfig: Record<string, unknown> | null | undefined,
  binding: ManagedAgentGithubBinding,
): Record<string, unknown> {
  const next = cloneAgentConfig(agentConfig);
  next[AGENT_MANAGED_GITHUB_KEY] = {
    mode: binding.mode,
    connectionId: binding.connectionId,
    githubUserId: binding.githubUserId,
    githubUsername: binding.githubUsername,
    adminElizaUserId: binding.adminElizaUserId,
    connectedAt: binding.connectedAt,
    scopes: binding.scopes,
    ...(binding.connectionRole ? { connectionRole: binding.connectionRole } : {}),
    ...(binding.source ? { source: binding.source } : {}),
    ...(binding.githubDisplayName ? { githubDisplayName: binding.githubDisplayName } : {}),
    ...(binding.githubAvatarUrl ? { githubAvatarUrl: binding.githubAvatarUrl } : {}),
    ...(binding.githubEmail ? { githubEmail: binding.githubEmail } : {}),
  };
  return next;
}

export function withoutManagedAgentGithubBinding(
  agentConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = cloneAgentConfig(agentConfig);
  delete next[AGENT_MANAGED_GITHUB_KEY];
  return next;
}
