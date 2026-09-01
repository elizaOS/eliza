/**
 * Maps canonical DB-backed auth sessions to operator-verified knowledge-graph
 * entities for narrow guest LifeOps reads. Request headers never name the
 * entity: a live session identity must match one unique verified binding.
 */

import type http from "node:http";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { resolveAuthorizedRouteRole } from "@elizaos/app-core/api/auth";
import { AuthStore } from "@elizaos/app-core/services/auth-store";
import { type AgentRuntime, ElizaError } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";

export const AUTH_SESSION_ENTITY_PLATFORM = "eliza_auth_session";
export const AUTH_SESSION_CONNECTOR_ACCOUNT = "local-auth";

export type LifeOpsAuthenticatedPrincipal =
  | { kind: "owner"; entityId: string; authIdentityId: string | null }
  | { kind: "guest"; entityId: string; authIdentityId: string };

export type LifeOpsPrincipalResolution =
  | { ok: true; principal: LifeOpsAuthenticatedPrincipal }
  | { ok: false; status: 401 | 403 | 429 | 503; reason: string };

function authDb(runtime: AgentRuntime): unknown {
  return (runtime as { adapter?: { db?: unknown } | null }).adapter?.db;
}

async function verifiedEntityForAuthIdentity(
  runtime: AgentRuntime,
  authIdentityId: string,
): Promise<string | null> {
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) return null;
  const candidates = await graph.getEntityStore(runtime.agentId).resolve({
    type: "person",
    identity: {
      platform: AUTH_SESSION_ENTITY_PLATFORM,
      handle: authIdentityId,
      connectorAccountId: AUTH_SESSION_CONNECTOR_ACCOUNT,
    },
  });
  const exact = candidates.filter((candidate) =>
    candidate.entity.identities.some(
      (identity) =>
        identity.platform === AUTH_SESSION_ENTITY_PLATFORM &&
        identity.connectorAccountId === AUTH_SESSION_CONNECTOR_ACCOUNT &&
        identity.handle === authIdentityId &&
        identity.verified,
    ),
  );
  return exact.length === 1 ? (exact[0]?.entity.entityId ?? null) : null;
}

/** True only when an Entity retains a verified binding to a live machine identity. */
export async function entityHasVerifiedMachineAuthBinding(
  runtime: AgentRuntime,
  entityId: string,
): Promise<boolean> {
  const db = authDb(runtime);
  const graph = resolveKnowledgeGraphService(runtime);
  if (!db || !graph) return false;
  const entity = await graph.getEntityStore(runtime.agentId).get(entityId);
  if (!entity) return false;
  const auth = new AuthStore(db as ConstructorParameters<typeof AuthStore>[0]);
  for (const identity of entity.identities) {
    if (
      identity.platform !== AUTH_SESSION_ENTITY_PLATFORM ||
      identity.connectorAccountId !== AUTH_SESSION_CONNECTOR_ACCOUNT ||
      !identity.verified
    ) {
      continue;
    }
    const row = await auth.findIdentity(identity.handle);
    if (row?.kind === "machine") return true;
  }
  return false;
}

/** Resolve only a live owner or machine session to a canonical Entity. */
export async function resolveLifeOpsAuthenticatedPrincipal(args: {
  req: Pick<http.IncomingMessage, "headers" | "socket" | "method">;
  runtime: AgentRuntime;
}): Promise<LifeOpsPrincipalResolution> {
  const resolution = await resolveAuthorizedRouteRole(args.req, {
    state: { current: args.runtime },
  });
  if (!resolution.ok) {
    return {
      ok: false,
      status: resolution.status,
      reason: resolution.reason,
    };
  }
  if (resolution.role === "OWNER") {
    return {
      ok: true,
      principal: {
        kind: "owner",
        entityId: SELF_ENTITY_ID,
        authIdentityId: resolution.identityId ?? null,
      },
    };
  }
  if (resolution.role !== "USER" || !resolution.identityId) {
    return { ok: false, status: 403, reason: "Guest session is not eligible" };
  }
  const entityId = await verifiedEntityForAuthIdentity(
    args.runtime,
    resolution.identityId,
  );
  if (!entityId) {
    return {
      ok: false,
      status: 403,
      reason: "Guest session has no unique verified Entity binding",
    };
  }
  return {
    ok: true,
    principal: {
      kind: "guest",
      entityId,
      authIdentityId: resolution.identityId,
    },
  };
}

/**
 * Owner-only use-case for binding a paired machine identity to one Entity.
 * The auth row must exist, be machine-kind, and must not already bind another
 * Entity. This is the only supported way to create the verified auth mapping.
 */
export async function bindMachineAuthIdentityToEntity(args: {
  runtime: AgentRuntime;
  entityId: string;
  authIdentityId: string;
}): Promise<{ entityId: string; authIdentityId: string }> {
  const db = authDb(args.runtime);
  const graph = resolveKnowledgeGraphService(args.runtime);
  if (!db || !graph) {
    throw new ElizaError("Auth or knowledge-graph storage is unavailable", {
      code: "AUTH_ENTITY_BINDING_UNAVAILABLE",
    });
  }
  const authIdentity = await new AuthStore(
    db as ConstructorParameters<typeof AuthStore>[0],
  ).findIdentity(args.authIdentityId);
  if (authIdentity?.kind !== "machine") {
    throw new ElizaError("Auth identity is not a paired machine identity", {
      code: "AUTH_ENTITY_BINDING_INVALID_IDENTITY",
      context: { authIdentityId: args.authIdentityId },
    });
  }
  const store = graph.getEntityStore(args.runtime.agentId);
  const entity = await store.get(args.entityId);
  if (entity?.type !== "person" || entity.entityId === SELF_ENTITY_ID) {
    throw new ElizaError("Guest Entity must be an existing non-owner person", {
      code: "AUTH_ENTITY_BINDING_INVALID_ENTITY",
      context: { entityId: args.entityId },
    });
  }
  const existing = await verifiedEntityForAuthIdentity(
    args.runtime,
    args.authIdentityId,
  );
  if (existing && existing !== entity.entityId) {
    throw new ElizaError("Auth identity is already bound to another Entity", {
      code: "AUTH_ENTITY_BINDING_CONFLICT",
      context: { existingEntityId: existing },
    });
  }
  const retained = entity.identities.filter(
    (identity) =>
      !(
        identity.platform === AUTH_SESSION_ENTITY_PLATFORM &&
        identity.connectorAccountId === AUTH_SESSION_CONNECTOR_ACCOUNT &&
        identity.handle === args.authIdentityId
      ),
  );
  await store.upsert({
    entityId: entity.entityId,
    type: entity.type,
    preferredName: entity.preferredName,
    ...(entity.fullName ? { fullName: entity.fullName } : {}),
    identities: [
      ...retained,
      {
        platform: AUTH_SESSION_ENTITY_PLATFORM,
        handle: args.authIdentityId,
        connectorAccountId: AUTH_SESSION_CONNECTOR_ACCOUNT,
        displayName: authIdentity.displayName,
        verified: true,
        confidence: 1,
        addedAt: new Date().toISOString(),
        addedVia: "import",
        evidence: ["owner_bound_paired_machine_session"],
      },
    ],
    ...(entity.attributes ? { attributes: entity.attributes } : {}),
    state: entity.state,
    tags: entity.tags,
    visibility: entity.visibility,
  });
  return { entityId: entity.entityId, authIdentityId: args.authIdentityId };
}
