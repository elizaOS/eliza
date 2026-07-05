/**
 * Role-based access control for the TASKS surface. `requireTaskAgentAccess`
 * gates create/interact abilities per connector against the caller's role,
 * reading operator-declared policy over a conservative default that only lets
 * admins spawn or drive agents from third-party connectors.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type IAgentRuntime,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type Memory,
} from "@elizaos/core";
import { readAliasedEnv } from "@elizaos/shared";

type RoleName = "OWNER" | "ADMIN" | "USER" | "GUEST";
type TaskAgentAbility = "create" | "interact";
type ConnectorPolicy = Partial<Record<TaskAgentAbility, RoleName>>;
type TaskAgentPolicyConfig = {
  default?: RoleName | ConnectorPolicy;
  connectors?: Record<string, RoleName | ConnectorPolicy>;
};

const ROLE_RANK: Record<RoleName, number> = {
  GUEST: 0,
  USER: 1,
  ADMIN: 2,
  OWNER: 3,
};

const DEFAULT_POLICY: TaskAgentPolicyConfig = {
  default: "GUEST",
  connectors: {
    discord: {
      create: "ADMIN",
      interact: "ADMIN",
    },
  },
};

type RoleCheckResult = {
  role: RoleName;
  isAdmin: boolean;
  isOwner: boolean;
};

const LOCAL_ROLES_MODULE_CANDIDATES = [
  path.resolve(process.cwd(), "packages/plugin-roles/src/index.ts"),
  path.resolve(process.cwd(), "packages/plugin-roles/dist/index.js"),
  path.resolve(process.cwd(), "packages/agent/src/runtime/roles/src/index.ts"),
];

function normalizeRole(value: unknown): RoleName {
  const upper = typeof value === "string" ? value.trim().toUpperCase() : "";
  switch (upper) {
    case "OWNER":
    case "ADMIN":
    case "USER":
      return upper;
    default:
      return "GUEST";
  }
}

function normalizeConnectorPolicy(
  value: RoleName | ConnectorPolicy | undefined,
): ConnectorPolicy {
  if (!value) return {};
  if (typeof value === "string") {
    const role = normalizeRole(value);
    return {
      create: role,
      interact: role,
    };
  }
  return {
    ...(value.create ? { create: normalizeRole(value.create) } : {}),
    ...(value.interact ? { interact: normalizeRole(value.interact) } : {}),
  };
}

function parseTaskAgentPolicy(runtime: IAgentRuntime): TaskAgentPolicyConfig {
  if (typeof runtime.getSetting !== "function") {
    return DEFAULT_POLICY;
  }

  const configured =
    runtime.getSetting("TASK_AGENT_ROLE_POLICY") ??
    runtime.getSetting("TASK_AGENT_CONNECTOR_ROLE_POLICY");

  if (!configured) {
    return DEFAULT_POLICY;
  }

  let parsed: unknown = configured;
  if (typeof configured === "string") {
    try {
      parsed = JSON.parse(configured);
    } catch {
      // error-policy:J3 malformed operator policy JSON → conservative built-in default (fails closed, same as an absent setting)
      return DEFAULT_POLICY;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return DEFAULT_POLICY;
  }

  const record = parsed as Record<string, unknown>;
  const parsedConnectors =
    record.connectors &&
    typeof record.connectors === "object" &&
    !Array.isArray(record.connectors)
      ? Object.fromEntries(
          Object.entries(record.connectors as Record<string, unknown>).map(
            ([connector, value]) => [
              connector,
              normalizeConnectorPolicy(value as RoleName | ConnectorPolicy),
            ],
          ),
        )
      : {};
  // MERGE over the built-in defaults, don't replace them: a partial override
  // (e.g. only `{"slack":"ADMIN"}`) must not silently drop the built-in Discord
  // ADMIN gate and fall through to the GUEST default — that would open
  // task-agent create/interact in Discord to anyone.
  const connectors = { ...DEFAULT_POLICY.connectors, ...parsedConnectors };

  return {
    default: normalizeConnectorPolicy(
      (record.default ?? DEFAULT_POLICY.default) as RoleName | ConnectorPolicy,
    ),
    connectors,
  };
}

function getConnectorFromBridgeMetadata(message: Memory): string | null {
  const metadata = (message.content as Record<string, unknown> | undefined)
    ?.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const bridgeSender = (metadata as Record<string, unknown>).bridgeSender;
  if (!bridgeSender || typeof bridgeSender !== "object") return null;
  const liveMetadata = (bridgeSender as Record<string, unknown>).metadata;
  if (!liveMetadata || typeof liveMetadata !== "object") return null;

  for (const [connector, value] of Object.entries(
    liveMetadata as Record<string, unknown>,
  )) {
    if (value && typeof value === "object") {
      return connector;
    }
  }
  return null;
}

// Fail-closed sentinel: distinct from `null`. A `null` connector means "genuine
// client-chat, no connector policy" and requireTaskAgentAccess treats it as the
// permissive GUEST default. An infra failure resolving the source must NOT read
// as that default, so it returns this symbol instead and the caller denies on it.
const SOURCE_RESOLUTION_FAILED: unique symbol = Symbol(
  "task-policy.source-resolution-failed",
);
type ConnectorSource = string | null | typeof SOURCE_RESOLUTION_FAILED;

async function resolveConnectorSource(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<ConnectorSource> {
  const content = message.content as Record<string, unknown> | undefined;
  const directSource =
    typeof content?.source === "string" &&
    content.source !== MESSAGE_SOURCE_CLIENT_CHAT
      ? content.source
      : null;
  if (directSource) return directSource;

  const bridgeSource = getConnectorFromBridgeMetadata(message);
  if (bridgeSource) return bridgeSource;

  try {
    const room = await runtime.getRoom(message.roomId);
    if (typeof room?.source === "string" && room.source.trim().length > 0) {
      return room.source;
    }
  } catch (error) {
    // error-policy:J1 room-source lookup failed at an infra boundary. Returning
    // null here would read as "genuine client-chat" → the permissive GUEST
    // default in requireTaskAgentAccess, silently opening task-agent
    // create/interact to any caller on a transient DB/room error. Surface the
    // failure (reportError → RECENT_ERRORS + ERROR_REPORTED) and fail closed via
    // the sentinel, which the caller translates to access-denied.
    runtime.reportError("task-policy.resolveConnectorSource", error, {
      roomId: message.roomId,
    });
    return SOURCE_RESOLUTION_FAILED;
  }

  return null;
}

async function resolveSenderRole(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<RoleCheckResult | null> {
  if (readAliasedEnv("ELIZA_SKIP_LOCAL_PLUGIN_ROLES") !== "1") {
    for (const candidate of LOCAL_ROLES_MODULE_CANDIDATES) {
      if (!fs.existsSync(candidate)) {
        continue;
      }

      try {
        const localRolesModule = (await import(
          pathToFileURL(candidate).href
        )) as {
          checkSenderRole?: (
            runtime: IAgentRuntime,
            message: Memory,
          ) => Promise<RoleCheckResult | null>;
        };
        if (typeof localRolesModule.checkSenderRole === "function") {
          return await localRolesModule.checkSenderRole(runtime, message);
        }
      } catch {
        // error-policy:J4 optional local roles module unresolvable here → fall through to the installed @elizaos/core import below
        // fall through to the installed package import below
      }
    }
  }

  try {
    const rolesModule = (await import("@elizaos/core")) as {
      checkSenderRole?: (
        runtime: IAgentRuntime,
        message: Memory,
      ) => Promise<RoleCheckResult | null>;
    };
    if (typeof rolesModule.checkSenderRole === "function") {
      return await rolesModule.checkSenderRole(runtime, message);
    }
  } catch {
    // error-policy:J4 roles package unavailable (standalone tests) → null role → caller denies any non-GUEST requirement (fails closed)
    // Package not available in standalone tests.
  }
  return null;
}

export async function requireTaskAgentAccess(
  runtime: IAgentRuntime,
  message: Memory,
  ability: TaskAgentAbility,
): Promise<
  | {
      allowed: true;
      connector: string | null;
      requiredRole: RoleName;
      actualRole: RoleName;
    }
  | {
      allowed: false;
      connector: string | null;
      requiredRole: RoleName;
      actualRole: RoleName;
      reason: string;
    }
> {
  const messageEntityId =
    typeof message.entityId === "string" && message.entityId.length > 0
      ? message.entityId
      : null;
  const runtimeAgentId =
    typeof runtime.agentId === "string" && runtime.agentId.length > 0
      ? runtime.agentId
      : null;

  if (messageEntityId && runtimeAgentId && messageEntityId === runtimeAgentId) {
    return {
      allowed: true,
      connector: null,
      requiredRole: "GUEST",
      actualRole: "OWNER",
    };
  }

  const resolvedSource = await resolveConnectorSource(runtime, message);
  if (resolvedSource === SOURCE_RESOLUTION_FAILED) {
    // Infra failure resolving the request source: deny rather than fall through
    // to the permissive GUEST default. reportError already surfaced the cause.
    return {
      allowed: false,
      connector: null,
      requiredRole: "OWNER",
      actualRole: "GUEST",
      reason:
        "Task-agent access denied: unable to resolve the request source (infrastructure error).",
    };
  }
  const connector: string | null = resolvedSource;
  const policy = parseTaskAgentPolicy(runtime);
  const connectorPolicy = connector
    ? normalizeConnectorPolicy(policy.connectors?.[connector])
    : {};
  const defaultPolicy = normalizeConnectorPolicy(
    policy.default as RoleName | ConnectorPolicy,
  );
  const requiredRole =
    connectorPolicy[ability] ?? defaultPolicy[ability] ?? "GUEST";

  if (requiredRole === "GUEST") {
    return {
      allowed: true,
      connector,
      requiredRole,
      actualRole: "GUEST",
    };
  }

  const roleCheck = await resolveSenderRole(runtime, message);
  if (!roleCheck) {
    return {
      allowed: false,
      connector,
      requiredRole,
      actualRole: "GUEST",
      reason:
        connector === "discord"
          ? "Task-agent access in Discord requires a verified OWNER or ADMIN role."
          : "Task-agent access requires a verified role, but role context is unavailable.",
    };
  }

  const actualRole = normalizeRole(roleCheck.role);
  if (ROLE_RANK[actualRole] < ROLE_RANK[requiredRole]) {
    return {
      allowed: false,
      connector,
      requiredRole,
      actualRole,
      reason:
        connector === "discord"
          ? `Task-agent access in Discord requires ${requiredRole} or higher. Current role: ${actualRole}.`
          : `Task-agent access requires ${requiredRole} or higher. Current role: ${actualRole}.`,
    };
  }

  return {
    allowed: true,
    connector,
    requiredRole,
    actualRole,
  };
}
