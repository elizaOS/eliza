import type { SensitiveRequestActorPolicy, SensitiveRequestPolicy } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import { dbRead } from "@/db/client";
import { usersRepository } from "@/db/repositories/users";
import { platformCredentials } from "@/db/schemas/platform-credentials";

export type SensitiveRequestActor =
  | {
      kind: "anonymous";
    }
  | {
      kind: "cloud_session";
      userId: string;
      organizationId?: string | null;
      role?: string | null;
      entityId?: string | null;
      entityIds?: string[];
    }
  | {
      kind: "connector_identity";
      platform: string;
      externalId: string;
      organizationId?: string | null;
      cloudUserId?: string | null;
      role?: string | null;
      entityId?: string | null;
      entityIds?: string[];
      verified?: boolean;
      email?: string | null;
      username?: string | null;
    }
  | {
      kind: "oauth_connection";
      provider: string;
      connectionId?: string | null;
      platformUserId: string;
      organizationId?: string | null;
      cloudUserId?: string | null;
      role?: string | null;
      entityId?: string | null;
      entityIds?: string[];
      verified?: boolean;
      email?: string | null;
      username?: string | null;
    };

export interface SensitiveRequestAuthorizationContext {
  policy: SensitiveRequestPolicy | SensitiveRequestActorPolicy;
  organizationId?: string | null;
  ownerUserId?: string | null;
  ownerEntityId?: string | null;
  requesterUserId?: string | null;
  requesterEntityId?: string | null;
}

export interface ResolvedSensitiveRequestActor {
  authenticated: boolean;
  userId?: string | null;
  organizationId?: string | null;
  role?: string | null;
  entityIds: string[];
  connector?: {
    platform: string;
    externalId: string;
  };
}

export interface SensitiveRequestIdentityAuthorizationAdapter {
  resolveCloudSession?(
    actor: Extract<SensitiveRequestActor, { kind: "cloud_session" }>,
  ): Promise<ResolvedSensitiveRequestActor | null>;
  resolveConnectorIdentity?(
    actor: Extract<SensitiveRequestActor, { kind: "connector_identity" | "oauth_connection" }>,
  ): Promise<ResolvedSensitiveRequestActor | null>;
  areEntitiesLinked?(leftEntityId: string, rightEntityId: string): Promise<boolean>;
}

export interface SensitiveRequestAuthorizationDecision {
  allowed: boolean;
  actorPolicy: SensitiveRequestActorPolicy;
  reason: string;
  matchedBy?:
    | "any_payer"
    | "verified_actor"
    | "organization_admin"
    | "owner_user"
    | "owner_entity"
    | "linked_identity";
  actorUserId?: string;
  actorEntityIds?: string[];
  organizationId?: string;
}

function actorPolicyFrom(
  policy: SensitiveRequestPolicy | SensitiveRequestActorPolicy,
): SensitiveRequestActorPolicy {
  return typeof policy === "string" ? policy : policy.actor;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeEntityIds(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeNullableString(value))
        .filter((value): value is string => !!value),
    ),
  );
}

function hasOrganizationAdminRole(role: string | null | undefined): boolean {
  switch (role?.trim().toLowerCase()) {
    case "owner":
    case "admin":
    case "administrator":
    case "super_admin":
      return true;
    default:
      return false;
  }
}

function organizationMatches(
  expectedOrganizationId: string | null | undefined,
  actualOrganizationId: string | null | undefined,
): boolean {
  if (!expectedOrganizationId) return true;
  return actualOrganizationId === expectedOrganizationId;
}

function fallbackResolvedCloudSession(
  actor: Extract<SensitiveRequestActor, { kind: "cloud_session" }>,
): ResolvedSensitiveRequestActor {
  return {
    authenticated: true,
    userId: actor.userId,
    organizationId: actor.organizationId ?? null,
    role: actor.role ?? null,
    entityIds: normalizeEntityIds([actor.entityId, actor.userId, ...(actor.entityIds ?? [])]),
  };
}

function fallbackResolvedConnectorIdentity(
  actor: Extract<SensitiveRequestActor, { kind: "connector_identity" | "oauth_connection" }>,
): ResolvedSensitiveRequestActor {
  const platform = actor.kind === "oauth_connection" ? actor.provider : actor.platform;
  const externalId = actor.kind === "oauth_connection" ? actor.platformUserId : actor.externalId;
  return {
    authenticated: actor.verified !== false,
    userId: actor.cloudUserId ?? null,
    organizationId: actor.organizationId ?? null,
    role: actor.role ?? null,
    entityIds: normalizeEntityIds([
      actor.entityId,
      actor.cloudUserId ?? undefined,
      ...(actor.entityIds ?? []),
    ]),
    connector: { platform, externalId },
  };
}

async function resolveActor(
  actor: SensitiveRequestActor,
  adapter: SensitiveRequestIdentityAuthorizationAdapter | undefined,
): Promise<ResolvedSensitiveRequestActor> {
  if (actor.kind === "anonymous") {
    return { authenticated: false, entityIds: [] };
  }

  if (actor.kind === "cloud_session") {
    const resolved = await adapter?.resolveCloudSession?.(actor);
    if (resolved) {
      return {
        ...resolved,
        authenticated: resolved.authenticated !== false,
        entityIds: normalizeEntityIds([
          ...(resolved.entityIds ?? []),
          actor.entityId,
          actor.userId,
          ...(actor.entityIds ?? []),
        ]),
      };
    }
    return fallbackResolvedCloudSession(actor);
  }

  const resolved = await adapter?.resolveConnectorIdentity?.(actor);
  const fallback = fallbackResolvedConnectorIdentity(actor);
  if (!resolved) return fallback;

  return {
    ...resolved,
    authenticated: resolved.authenticated !== false && fallback.authenticated,
    userId: resolved.userId ?? fallback.userId,
    organizationId: resolved.organizationId ?? fallback.organizationId,
    role: resolved.role ?? fallback.role,
    entityIds: normalizeEntityIds([...(resolved.entityIds ?? []), ...(fallback.entityIds ?? [])]),
    connector: resolved.connector ?? fallback.connector,
  };
}

async function hasLinkedOwnerEntity(params: {
  ownerEntityId: string;
  actorEntityIds: string[];
  adapter?: SensitiveRequestIdentityAuthorizationAdapter;
}): Promise<boolean> {
  for (const actorEntityId of params.actorEntityIds) {
    if (actorEntityId === params.ownerEntityId) {
      return true;
    }
    if (await params.adapter?.areEntitiesLinked?.(actorEntityId, params.ownerEntityId)) {
      return true;
    }
  }
  return false;
}

export async function authorizeSensitiveRequestActor(params: {
  actor: SensitiveRequestActor;
  context: SensitiveRequestAuthorizationContext;
  adapter?: SensitiveRequestIdentityAuthorizationAdapter;
}): Promise<SensitiveRequestAuthorizationDecision> {
  const actorPolicy = actorPolicyFrom(params.context.policy);
  const resolved = await resolveActor(params.actor, params.adapter);
  const actorUserId = normalizeNullableString(resolved.userId);
  const actorEntityIds = normalizeEntityIds(resolved.entityIds);
  const organizationId = normalizeNullableString(resolved.organizationId);

  const baseDecision = {
    actorPolicy,
    actorUserId: actorUserId ?? undefined,
    actorEntityIds,
    organizationId: organizationId ?? undefined,
  };

  if (actorPolicy === "any_payer") {
    return {
      ...baseDecision,
      allowed: true,
      matchedBy: "any_payer",
      reason: "policy allows any payer",
    };
  }

  if (!resolved.authenticated) {
    return {
      ...baseDecision,
      allowed: false,
      reason: "actor is not authenticated",
    };
  }

  if (!organizationMatches(params.context.organizationId, organizationId)) {
    return {
      ...baseDecision,
      allowed: false,
      reason: "actor organization does not match request organization",
    };
  }

  if (actorPolicy === "verified_payer") {
    return {
      ...baseDecision,
      allowed: true,
      matchedBy: "verified_actor",
      reason: "actor is authenticated for the request organization",
    };
  }

  if (actorPolicy === "organization_admin") {
    if (hasOrganizationAdminRole(resolved.role)) {
      return {
        ...baseDecision,
        allowed: true,
        matchedBy: "organization_admin",
        reason: "actor is an organization admin",
      };
    }

    return {
      ...baseDecision,
      allowed: false,
      reason: "actor is not an organization admin",
    };
  }

  const ownerUserId = normalizeNullableString(params.context.ownerUserId);
  if (ownerUserId && actorUserId === ownerUserId) {
    return {
      ...baseDecision,
      allowed: true,
      matchedBy: "owner_user",
      reason: "actor cloud user matches request owner",
    };
  }

  const ownerEntityId = normalizeNullableString(params.context.ownerEntityId);
  if (ownerEntityId) {
    const linked = await hasLinkedOwnerEntity({
      ownerEntityId,
      actorEntityIds,
      adapter: params.adapter,
    });
    if (linked) {
      return {
        ...baseDecision,
        allowed: true,
        matchedBy: actorEntityIds.includes(ownerEntityId) ? "owner_entity" : "linked_identity",
        reason: "actor identity is linked to the request owner",
      };
    }
  }

  return {
    ...baseDecision,
    allowed: false,
    reason:
      ownerEntityId || ownerUserId
        ? "actor is not linked to the request owner"
        : "request owner identity is missing",
  };
}

export function createCloudSensitiveRequestAuthorizationAdapter(): SensitiveRequestIdentityAuthorizationAdapter {
  return {
    async resolveCloudSession(actor) {
      const user = await usersRepository.findWithOrganization(actor.userId);
      if (!user) {
        return null;
      }

      return {
        authenticated: user.is_active,
        userId: user.id,
        organizationId: user.organization_id ?? null,
        role: user.role,
        entityIds: normalizeEntityIds([user.id, actor.entityId, ...(actor.entityIds ?? [])]),
      };
    },

    async resolveConnectorIdentity(actor) {
      const platform = actor.kind === "oauth_connection" ? actor.provider : actor.platform;
      const externalId =
        actor.kind === "oauth_connection" ? actor.platformUserId : actor.externalId;
      const normalizedPlatform = platform.trim().toLowerCase();
      let user:
        | Awaited<ReturnType<typeof usersRepository.findByDiscordIdWithOrganization>>
        | undefined;

      switch (normalizedPlatform) {
        case "discord":
          user = await usersRepository.findByDiscordIdWithOrganization(externalId);
          break;
        case "telegram":
          user = await usersRepository.findByTelegramIdWithOrganization(externalId);
          break;
        case "whatsapp":
          user = await usersRepository.findByWhatsAppIdWithOrganization(externalId);
          break;
        case "phone":
        case "sms":
          user = await usersRepository.findByPhoneNumberWithOrganization(externalId);
          break;
        case "steward":
          user = await usersRepository.findByStewardIdWithOrganization(externalId);
          break;
        default:
          user = undefined;
      }

      if (user) {
        return {
          authenticated: user.is_active,
          userId: user.id,
          organizationId: user.organization_id ?? null,
          role: user.role,
          entityIds: normalizeEntityIds([
            user.id,
            actor.entityId,
            actor.cloudUserId ?? undefined,
            ...(actor.entityIds ?? []),
          ]),
          connector: { platform: normalizedPlatform, externalId },
        };
      }

      const providerPlatform =
        normalizedPlatform as (typeof platformCredentials.platform.enumValues)[number];
      const existing = await dbRead
        .select({
          userId: platformCredentials.user_id,
          organizationId: platformCredentials.organization_id,
          status: platformCredentials.status,
        })
        .from(platformCredentials)
        .where(
          and(
            eq(platformCredentials.platform, providerPlatform),
            eq(platformCredentials.platform_user_id, externalId),
          ),
        )
        .limit(1);

      const credential = existing[0];
      if (!credential || credential.status !== "active") {
        return null;
      }

      return {
        authenticated: true,
        userId: credential.userId ?? null,
        organizationId: credential.organizationId,
        entityIds: normalizeEntityIds([
          credential.userId ?? undefined,
          actor.entityId,
          actor.cloudUserId ?? undefined,
          ...(actor.entityIds ?? []),
        ]),
        connector: { platform: normalizedPlatform, externalId },
      };
    },
  };
}
