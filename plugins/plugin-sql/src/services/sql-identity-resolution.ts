/**
 * SQL-backed canonical identity authority. Merge and split serialize through
 * the per-agent generation row and commit journal, confirmation consumption,
 * and versioned redirects in one transaction. Source entities and claims are
 * immutable inputs; consumer projections follow redirects and repair later.
 */
import {
  type CommitIdentityMergeRequest,
  ElizaError,
  type IAgentRuntime,
  IDENTITY_AUTHORITY_CONTRACT_VERSION,
  type IdentityCanonicalRedirect,
  type IdentityCanonicalResolution,
  type IdentityClaim,
  type IdentityClaimConflict,
  type IdentityClaimScope,
  type IdentityCluster,
  type IdentityJournalPage,
  type IdentityMergeConfirmation,
  type IdentityMergePlan,
  IdentityResolutionService,
  type JsonObject,
  type MergeJournal,
  type OwnerBindingEvaluation,
  type ProposeIdentityMergeRequest,
  type Service,
  type SplitIdentityRequest,
  type UUID,
} from "@elizaos/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { authOwnerBindingTable } from "../schema/authOwnerBinding";
import { connectorAccountsTable } from "../schema/connectorAccounts";
import { entityTable } from "../schema/entity";
import {
  identityAuthorityStateTable,
  identityCanonicalRedirectTable,
  identityClaimTable,
  identityMergeConfirmationTable,
  identityMergeJournalTable,
} from "../schema/identityAuthority";
import { type DrizzleDatabase, getDb } from "../types";

const PLAN_TTL_MS = 15 * 60_000;
const CONFIRMATION_TTL_MS = 5 * 60_000;
const MAX_JOURNAL_PAGE = 100;
const PENDING_CONSUMERS = Object.freeze([
  "runtime-relationships",
  "contacts",
  "lifeops",
  "roles",
  "message",
  "notifications",
  "document-acls",
]);

type JournalRow = typeof identityMergeJournalTable.$inferSelect;
type RedirectRow = typeof identityCanonicalRedirectTable.$inferSelect;
type ClaimRow = typeof identityClaimTable.$inferSelect;

function fail(code: string, message: string, context: Record<string, unknown> = {}): never {
  throw new ElizaError(message, { code, context, severity: "fatal" });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") {
    return fail("IDENTITY_DIGEST_INVALID", "Identity digest input is not JSON.");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function digest(domain: string, value: unknown): string {
  const bytes = sha256(new TextEncoder().encode(`${domain}\n${stableJson(value)}`));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalizeIdentityRequest(
  operation: "propose-merge" | "commit-merge" | "split",
  value: JsonObject
): JsonObject {
  const normalized: JsonObject = { ...value };
  const setField = operation === "propose-merge" ? "sourcePrincipalIds" : "principalIds";
  const candidate = normalized[setField];
  if (operation !== "commit-merge" && Array.isArray(candidate)) {
    normalized[setField] = [...candidate].sort((left, right) =>
      String(left).localeCompare(String(right))
    );
  }
  return normalized;
}

export function computeIdentityRequestDigest(
  operation: "propose-merge" | "commit-merge" | "split",
  value: JsonObject
): string {
  return digest(`elizaos:identity:${operation}:v1`, canonicalizeIdentityRequest(operation, value));
}

function assertRequestDigest(
  actual: string,
  operation: Parameters<typeof computeIdentityRequestDigest>[0],
  value: JsonObject
): void {
  if (actual !== computeIdentityRequestDigest(operation, value)) {
    fail(
      "IDENTITY_REQUEST_DIGEST_MISMATCH",
      "Identity request digest does not match the request.",
      {
        operation,
      }
    );
  }
}

function newId(): UUID {
  return globalThis.crypto.randomUUID() as UUID;
}
function iso(value: Date): string {
  return value.toISOString();
}
function toDbObject(value: unknown): Record<string, unknown> {
  return JSON.parse(stableJson(value)) as Record<string, unknown>;
}
function asJsonObject(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("IDENTITY_PERSISTED_JSON_INVALID", `Persisted ${field} is invalid.`, { field });
  }
  return value as JsonObject;
}
function asUuidArray(value: unknown, field: string): UUID[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return fail("IDENTITY_PERSISTED_JSON_INVALID", `Persisted ${field} is invalid.`, { field });
  }
  return value as UUID[];
}

function mapClaim(row: ClaimRow): IdentityClaim {
  return {
    contractVersion: 1,
    id: row.id as UUID,
    agentId: row.agentId as UUID,
    principalEntityId: row.principalEntityId as UUID,
    namespace: row.namespace,
    connectorId: row.connectorId,
    connectorAccountId: row.connectorAccountId as UUID,
    externalSubjectId: row.externalSubjectId,
    handle: row.handle,
    displayName: row.displayName,
    verification: row.verification as IdentityClaim["verification"],
    status: row.status as IdentityClaim["status"],
    confidence: row.confidence,
    ownerBindingId: row.ownerBindingId,
    provenance: asJsonObject(row.provenance, "claim.provenance"),
    evidence: asJsonObject(row.evidence, "claim.evidence"),
    firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt),
    verifiedAt: row.verifiedAt ? iso(row.verifiedAt) : null,
    revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function mapRedirect(row: RedirectRow): IdentityCanonicalRedirect {
  return {
    contractVersion: 1,
    id: row.id as UUID,
    agentId: row.agentId as UUID,
    sourcePrincipalId: row.sourcePrincipalId as UUID,
    canonicalPrincipalId: row.canonicalPrincipalId as UUID,
    mergeJournalId: row.mergeJournalId as UUID,
    version: row.version,
    status: row.status as IdentityCanonicalRedirect["status"],
    createdAt: iso(row.createdAt),
    supersededAt: row.supersededAt ? iso(row.supersededAt) : null,
  };
}

function mapJournal(row: JournalRow): MergeJournal {
  return {
    contractVersion: IDENTITY_AUTHORITY_CONTRACT_VERSION,
    id: row.id as UUID,
    agentId: row.agentId as UUID,
    operation: row.operation as MergeJournal["operation"],
    status: row.status as MergeJournal["status"],
    parentJournalId: row.parentJournalId as UUID | null,
    actorPrincipalId: row.actorPrincipalId as UUID,
    canonicalPrincipalId: row.canonicalPrincipalId as UUID,
    sourcePrincipalIds: asUuidArray(row.sourcePrincipalIds, "journal.sourcePrincipalIds"),
    plan: asJsonObject(row.plan, "journal.plan") as unknown as IdentityMergePlan,
    beforeState: asJsonObject(row.beforeState, "journal.beforeState"),
    result: row.result
      ? (asJsonObject(row.result, "journal.result") as unknown as MergeJournal["result"])
      : null,
    reason: row.reason,
    createdAt: iso(row.createdAt),
    committedAt: row.committedAt ? iso(row.committedAt) : null,
    completedAt: row.completedAt ? iso(row.completedAt) : null,
  };
}

function follow(
  principalId: UUID,
  redirects: readonly RedirectRow[]
): { canonical: UUID; ids: UUID[] } {
  const bySource = new Map(
    redirects.filter((row) => row.status === "active").map((row) => [row.sourcePrincipalId, row])
  );
  const seen = new Set<UUID>();
  const ids: UUID[] = [];
  let current = principalId;
  while (bySource.has(current)) {
    if (seen.has(current)) {
      fail("IDENTITY_REDIRECT_CYCLE", "Canonical redirect cycle detected.", { principalId });
    }
    seen.add(current);
    const redirect = bySource.get(current);
    if (!redirect) break;
    ids.push(redirect.id as UUID);
    current = redirect.canonicalPrincipalId as UUID;
  }
  return { canonical: current, ids };
}

export class SqlIdentityResolutionService extends IdentityResolutionService {
  static override readonly serviceType = IdentityResolutionService.serviceType;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new SqlIdentityResolutionService(runtime);
    if (!service.db) {
      fail(
        "IDENTITY_SQL_ADAPTER_REQUIRED",
        "SQL identity authority requires a Drizzle-backed adapter."
      );
    }
    return service;
  }

  async stop(): Promise<void> {}

  private get db(): DrizzleDatabase {
    return getDb(this.runtime.adapter);
  }

  private assertAgent(agentId: UUID): void {
    if (agentId !== this.runtime.agentId) {
      fail("IDENTITY_TENANT_MISMATCH", "Identity request is outside this runtime tenant.", {
        agentId,
      });
    }
  }

  async resolveCanonicalPrincipal(
    agentId: UUID,
    principalId: UUID
  ): Promise<IdentityCanonicalResolution> {
    this.assertAgent(agentId);
    const [states, redirects] = await Promise.all([
      this.db
        .select()
        .from(identityAuthorityStateTable)
        .where(eq(identityAuthorityStateTable.agentId, agentId))
        .limit(1),
      this.db
        .select()
        .from(identityCanonicalRedirectTable)
        .where(
          and(
            eq(identityCanonicalRedirectTable.agentId, agentId),
            eq(identityCanonicalRedirectTable.status, "active")
          )
        ),
    ]);
    const resolved = follow(principalId, redirects);
    return {
      agentId,
      requestedPrincipalId: principalId,
      canonicalPrincipalId: resolved.canonical,
      redirectIds: resolved.ids,
      generation: states[0]?.generation ?? 0,
    };
  }

  async resolveForDisplay(agentId: UUID, principalId: UUID): Promise<IdentityCanonicalResolution> {
    return this.resolveCanonicalPrincipal(agentId, principalId);
  }

  async resolveForDataAccess(
    agentId: UUID,
    principalId: UUID
  ): Promise<IdentityCanonicalResolution> {
    return this.resolveCanonicalPrincipal(agentId, principalId);
  }

  async resolveClaim(scope: IdentityClaimScope): Promise<IdentityClaim | null> {
    this.assertAgent(scope.agentId);
    const [row] = await this.db
      .select()
      .from(identityClaimTable)
      .where(
        and(
          eq(identityClaimTable.agentId, scope.agentId),
          eq(identityClaimTable.namespace, scope.namespace),
          eq(identityClaimTable.connectorId, scope.connectorId),
          eq(identityClaimTable.connectorAccountId, scope.connectorAccountId),
          eq(identityClaimTable.externalSubjectId, scope.externalSubjectId),
          inArray(identityClaimTable.status, ["active", "disputed"])
        )
      )
      .limit(1);
    return row ? mapClaim(row) : null;
  }

  async getCluster(agentId: UUID, principalId: UUID): Promise<IdentityCluster | null> {
    this.assertAgent(agentId);
    const [entity] = await this.db
      .select({ id: entityTable.id })
      .from(entityTable)
      .where(and(eq(entityTable.agentId, agentId), eq(entityTable.id, principalId)))
      .limit(1);
    if (!entity) return null;
    const [states, redirects] = await Promise.all([
      this.db
        .select()
        .from(identityAuthorityStateTable)
        .where(eq(identityAuthorityStateTable.agentId, agentId))
        .limit(1),
      this.db
        .select()
        .from(identityCanonicalRedirectTable)
        .where(
          and(
            eq(identityCanonicalRedirectTable.agentId, agentId),
            eq(identityCanonicalRedirectTable.status, "active")
          )
        ),
    ]);
    const canonical = follow(principalId, redirects).canonical;
    const principalIds = new Set<UUID>([canonical]);
    for (const redirect of redirects) {
      if (follow(redirect.sourcePrincipalId as UUID, redirects).canonical === canonical) {
        principalIds.add(redirect.sourcePrincipalId as UUID);
      }
    }
    const claims = await this.db
      .select()
      .from(identityClaimTable)
      .where(
        and(
          eq(identityClaimTable.agentId, agentId),
          inArray(identityClaimTable.principalEntityId, [...principalIds])
        )
      );
    return {
      contractVersion: 1,
      agentId,
      canonicalPrincipalId: canonical,
      principalIds: [...principalIds].sort(),
      claims: claims.map(mapClaim),
      generation: states[0]?.generation ?? 0,
      readAt: new Date().toISOString(),
    };
  }

  async resolveVerifiedDeliveryClaims(
    agentId: UUID,
    principalId: UUID,
    connectorAccountId?: UUID
  ): Promise<readonly IdentityClaim[]> {
    const cluster = await this.getCluster(agentId, principalId);
    if (!cluster) return [];
    return cluster.claims.filter(
      (claim) =>
        claim.status === "active" &&
        (claim.verification === "verified" || claim.verification === "owner_bound") &&
        (connectorAccountId === undefined || claim.connectorAccountId === connectorAccountId)
    );
  }

  async evaluateOwnerBinding(
    request: Parameters<IdentityResolutionService["evaluateOwnerBinding"]>[0]
  ): Promise<OwnerBindingEvaluation> {
    this.assertAgent(request.agentId);
    const cluster = await this.getCluster(request.agentId, request.actorPrincipalId);
    if (!cluster) return { decision: "not_bound", reason: "no_active_binding" };
    const ownerClaim = cluster.claims.find(
      (claim) =>
        claim.status === "active" &&
        claim.verification === "owner_bound" &&
        claim.ownerBindingId !== null
    );
    if (!ownerClaim) return { decision: "not_bound", reason: "no_active_binding" };
    if (!request.candidateOwnerPrincipalIds.includes(cluster.canonicalPrincipalId)) {
      return { decision: "not_bound", reason: "wrong_owner" };
    }
    const [account] = await this.db
      .select({ ownerBindingId: connectorAccountsTable.ownerBindingId })
      .from(connectorAccountsTable)
      .where(
        and(
          eq(connectorAccountsTable.id, ownerClaim.connectorAccountId),
          eq(connectorAccountsTable.agentId, request.agentId),
          eq(connectorAccountsTable.ownerBindingId, ownerClaim.ownerBindingId as string)
        )
      )
      .limit(1);
    const [binding] = await this.db
      .select({
        connector: authOwnerBindingTable.connector,
        externalId: authOwnerBindingTable.externalId,
        verifiedAt: authOwnerBindingTable.verifiedAt,
      })
      .from(authOwnerBindingTable)
      .where(eq(authOwnerBindingTable.id, ownerClaim.ownerBindingId as string))
      .limit(1);
    if (
      !account ||
      !binding ||
      binding.connector !== ownerClaim.connectorId ||
      binding.externalId !== ownerClaim.externalSubjectId ||
      binding.verifiedAt <= 0
    ) {
      return { decision: "not_bound", reason: "no_active_binding" };
    }
    return {
      decision: "bound",
      actorCanonicalPrincipalId: cluster.canonicalPrincipalId,
      ownerPrincipalId: cluster.canonicalPrincipalId,
      claimId: ownerClaim.id,
      ownerBindingId: ownerClaim.ownerBindingId as string,
      generation: cluster.generation,
      reason: "verified_owner_binding",
    };
  }

  async proposeMerge(request: ProposeIdentityMergeRequest): Promise<IdentityMergePlan> {
    this.assertAgent(request.agentId);
    const sourceIds = [...new Set(request.sourcePrincipalIds)].sort();
    if (sourceIds.length === 0 || sourceIds.includes(request.canonicalPrincipalId)) {
      fail(
        "IDENTITY_MERGE_INPUT_INVALID",
        "Merge requires distinct canonical and source principals."
      );
    }
    assertRequestDigest(request.requestDigest, "propose-merge", {
      agentId: request.agentId,
      canonicalPrincipalId: request.canonicalPrincipalId,
      sourcePrincipalIds: sourceIds,
      actorPrincipalId: request.actorPrincipalId,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
    });
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(identityMergeJournalTable)
        .where(
          and(
            eq(identityMergeJournalTable.agentId, request.agentId),
            eq(identityMergeJournalTable.operation, "merge"),
            eq(identityMergeJournalTable.idempotencyKey, request.idempotencyKey)
          )
        )
        .limit(1);
      if (existing) {
        if (existing.requestDigest !== request.requestDigest) {
          fail("IDENTITY_IDEMPOTENCY_CONFLICT", "Proposal idempotency key was reused.");
        }
        return mapJournal(existing).plan;
      }
      await tx
        .insert(identityAuthorityStateTable)
        .values({ agentId: request.agentId })
        .onConflictDoNothing();
      const [state] = await tx
        .select()
        .from(identityAuthorityStateTable)
        .where(eq(identityAuthorityStateTable.agentId, request.agentId))
        .limit(1);
      if (!state) return fail("IDENTITY_STATE_MISSING", "Identity authority state is missing.");
      const ids = [request.canonicalPrincipalId, ...sourceIds, request.actorPrincipalId];
      const entities = await tx
        .select({ id: entityTable.id })
        .from(entityTable)
        .where(and(eq(entityTable.agentId, request.agentId), inArray(entityTable.id, ids)));
      if (new Set(entities.map((row) => row.id)).size !== new Set(ids).size) {
        fail("IDENTITY_PRINCIPAL_NOT_FOUND", "Every merge principal and actor must exist.");
      }
      const redirects = await tx
        .select()
        .from(identityCanonicalRedirectTable)
        .where(
          and(
            eq(identityCanonicalRedirectTable.agentId, request.agentId),
            eq(identityCanonicalRedirectTable.status, "active")
          )
        );
      const canonical = follow(request.canonicalPrincipalId, redirects).canonical;
      const roots = new Set(sourceIds.map((id) => follow(id, redirects).canonical));
      roots.delete(canonical);
      const expanded = new Set<UUID>(roots);
      for (const redirect of redirects) {
        if (roots.has(follow(redirect.sourcePrincipalId as UUID, redirects).canonical)) {
          expanded.add(redirect.sourcePrincipalId as UUID);
        }
      }
      if (expanded.size === 0) {
        fail("IDENTITY_ALREADY_CANONICAL", "All requested principals already resolve canonically.");
      }
      const clusterIds = [canonical, ...expanded];
      const claims = await tx
        .select()
        .from(identityClaimTable)
        .where(
          and(
            eq(identityClaimTable.agentId, request.agentId),
            inArray(identityClaimTable.principalEntityId, clusterIds),
            inArray(identityClaimTable.status, ["active", "disputed"])
          )
        );
      const ownerClaims = claims.filter(
        (claim) => claim.verification === "owner_bound" && claim.ownerBindingId
      );
      const ownerBindings = new Set(ownerClaims.map((claim) => claim.ownerBindingId));
      const conflictingClaims: IdentityClaimConflict[] =
        ownerBindings.size > 1
          ? [
              {
                claimIds: ownerClaims.map((claim) => claim.id as UUID),
                reason: "owner_binding",
                details: { ownerBindingIds: [...ownerBindings] },
              },
            ]
          : [];
      const now = new Date();
      const journalId = newId();
      const plan: IdentityMergePlan = {
        contractVersion: 1,
        id: journalId,
        agentId: request.agentId,
        operation: "merge",
        canonicalPrincipalId: canonical,
        sourcePrincipalIds: [...expanded].sort(),
        parentJournalId: null,
        expectedGeneration: state.generation,
        affectedReferences: [
          ...[...expanded].map((id) => ({
            consumer: "identity-canonical-redirects",
            referenceType: "principal",
            referenceId: id,
            principalId: id,
            resolution: "redirect_safe" as const,
          })),
          ...claims.map((claim) => ({
            consumer: "identity-claims",
            referenceType: "claim",
            referenceId: claim.id,
            principalId: claim.principalEntityId as UUID,
            resolution: "redirect_safe" as const,
          })),
        ],
        conflictingClaims,
        createdAt: iso(now),
        expiresAt: iso(new Date(now.getTime() + PLAN_TTL_MS)),
      };
      const planDigest = digest("elizaos:identity:merge-plan:v1", plan);
      await tx.insert(identityMergeJournalTable).values({
        id: journalId,
        agentId: request.agentId,
        operation: "merge",
        status: "planned",
        actorPrincipalId: request.actorPrincipalId,
        canonicalPrincipalId: canonical,
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        planDigest,
        expiresAt: new Date(plan.expiresAt),
        expectedGeneration: state.generation,
        sourcePrincipalIds: [...expanded].sort(),
        plan: toDbObject(plan),
        beforeState: toDbObject({
          generation: state.generation,
          redirects: redirects
            .filter((row) => clusterIds.includes(row.sourcePrincipalId as UUID))
            .map(mapRedirect),
          claims: claims.map(mapClaim),
        }),
        reason: request.reason,
      });
      return plan;
    });
  }

  async confirmMerge(
    request: Parameters<IdentityResolutionService["confirmMerge"]>[0]
  ): Promise<IdentityMergeConfirmation> {
    this.assertAgent(request.agentId);
    return this.db.transaction(async (tx) => {
      const [journal] = await tx
        .select()
        .from(identityMergeJournalTable)
        .where(
          and(
            eq(identityMergeJournalTable.id, request.planId),
            eq(identityMergeJournalTable.agentId, request.agentId)
          )
        )
        .for("update")
        .limit(1);
      if (journal?.operation !== "merge" || journal.status !== "planned") {
        fail("IDENTITY_PLAN_NOT_CONFIRMABLE", "Merge plan is not confirmable.");
      }
      const plan = mapJournal(journal).plan;
      const now = new Date();
      if (Date.parse(plan.expiresAt) <= now.getTime()) {
        fail("IDENTITY_PLAN_EXPIRED", "Merge plan expired.");
      }
      if (
        journal.actorPrincipalId !== request.actorPrincipalId ||
        journal.expectedGeneration !== request.expectedGeneration
      ) {
        fail("IDENTITY_CONFIRMATION_MISMATCH", "Confirmation does not match the plan.");
      }
      const [state] = await tx
        .select()
        .from(identityAuthorityStateTable)
        .where(eq(identityAuthorityStateTable.agentId, request.agentId))
        .limit(1);
      if (!state || state.generation !== request.expectedGeneration) {
        fail("IDENTITY_GENERATION_CONFLICT", "Identity graph changed after planning.");
      }
      const planDigest = digest("elizaos:identity:merge-plan:v1", plan);
      const [active] = await tx
        .select()
        .from(identityMergeConfirmationTable)
        .where(
          and(
            eq(identityMergeConfirmationTable.agentId, request.agentId),
            eq(identityMergeConfirmationTable.journalId, request.planId),
            eq(identityMergeConfirmationTable.status, "active")
          )
        )
        .limit(1);
      if (active && active.expiresAt > now) {
        if (
          active.actorPrincipalId !== request.actorPrincipalId ||
          active.expectedGeneration !== request.expectedGeneration ||
          active.planDigest !== planDigest
        ) {
          fail("IDENTITY_CONFIRMATION_CONFLICT", "Active confirmation does not match.");
        }
        return {
          id: active.id as UUID,
          agentId: request.agentId,
          planId: request.planId,
          expectedGeneration: active.expectedGeneration,
          actorPrincipalId: active.actorPrincipalId as UUID,
          planDigest: active.planDigest,
          status: "active",
          confirmedAt: iso(active.confirmedAt),
          expiresAt: iso(active.expiresAt),
          consumedAt: null,
        };
      }
      if (active) {
        fail("IDENTITY_CONFIRMATION_EXPIRED", "Merge confirmation expired; create a new plan.");
      }
      const id = newId();
      const expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_MS);
      await tx.insert(identityMergeConfirmationTable).values({
        id,
        agentId: request.agentId,
        journalId: request.planId,
        actorPrincipalId: request.actorPrincipalId,
        planDigest,
        expectedGeneration: request.expectedGeneration,
        status: "active",
        confirmedAt: now,
        expiresAt,
      });
      return {
        id,
        agentId: request.agentId,
        planId: request.planId,
        expectedGeneration: request.expectedGeneration,
        actorPrincipalId: request.actorPrincipalId,
        planDigest,
        status: "active",
        confirmedAt: iso(now),
        expiresAt: iso(expiresAt),
        consumedAt: null,
      };
    });
  }

  async commitMerge(request: CommitIdentityMergeRequest): Promise<MergeJournal> {
    this.assertAgent(request.agentId);
    assertRequestDigest(request.requestDigest, "commit-merge", {
      agentId: request.agentId,
      planId: request.planId,
      confirmationId: request.confirmationId,
      expectedGeneration: request.expectedGeneration,
      actorPrincipalId: request.actorPrincipalId,
      idempotencyKey: request.idempotencyKey,
    });
    return this.db.transaction(async (tx) => {
      const [journal] = await tx
        .select()
        .from(identityMergeJournalTable)
        .where(
          and(
            eq(identityMergeJournalTable.id, request.planId),
            eq(identityMergeJournalTable.agentId, request.agentId)
          )
        )
        .for("update")
        .limit(1);
      if (journal?.operation !== "merge") {
        fail("IDENTITY_PLAN_NOT_COMMITTABLE", "Merge plan is not committable.");
      }
      if (
        journal.expiresAt <= new Date() ||
        journal.planDigest !== digest("elizaos:identity:merge-plan:v1", mapJournal(journal).plan)
      ) {
        fail("IDENTITY_PLAN_EXPIRED", "Merge plan expired or its digest changed.");
      }
      if (journal.status === "committed" || journal.status === "completed") {
        if (
          journal.commitIdempotencyKey === request.idempotencyKey &&
          journal.commitRequestDigest === request.requestDigest
        ) {
          return mapJournal(journal);
        }
        fail("IDENTITY_IDEMPOTENCY_CONFLICT", "Merge was already committed by another request.");
      }
      if (journal.status !== "planned") {
        fail("IDENTITY_PLAN_NOT_COMMITTABLE", "Merge plan is not committable.");
      }
      const [sameKey] = await tx
        .select()
        .from(identityMergeJournalTable)
        .where(
          and(
            eq(identityMergeJournalTable.agentId, request.agentId),
            eq(identityMergeJournalTable.commitIdempotencyKey, request.idempotencyKey)
          )
        )
        .limit(1);
      if (sameKey) fail("IDENTITY_IDEMPOTENCY_CONFLICT", "Commit key was reused.");
      const plan = mapJournal(journal).plan;
      if (plan.conflictingClaims.length > 0) {
        fail("IDENTITY_CLAIM_CONFLICT", "Merge plan contains unresolved claim conflicts.");
      }
      const now = new Date();
      const [confirmation] = await tx
        .select()
        .from(identityMergeConfirmationTable)
        .where(
          and(
            eq(identityMergeConfirmationTable.id, request.confirmationId),
            eq(identityMergeConfirmationTable.agentId, request.agentId),
            eq(identityMergeConfirmationTable.journalId, request.planId),
            eq(identityMergeConfirmationTable.status, "active")
          )
        )
        .for("update")
        .limit(1);
      if (
        !confirmation ||
        confirmation.expiresAt <= now ||
        confirmation.actorPrincipalId !== request.actorPrincipalId ||
        confirmation.expectedGeneration !== request.expectedGeneration ||
        confirmation.planDigest !== digest("elizaos:identity:merge-plan:v1", plan)
      ) {
        fail("IDENTITY_CONFIRMATION_INVALID", "Merge confirmation is stale or mismatched.");
      }
      const consumed = await tx
        .update(identityMergeConfirmationTable)
        .set({ status: "consumed", consumedAt: now })
        .where(
          and(
            eq(identityMergeConfirmationTable.id, confirmation.id),
            eq(identityMergeConfirmationTable.status, "active")
          )
        )
        .returning();
      if (consumed.length !== 1) {
        fail("IDENTITY_CONFIRMATION_CONSUMED", "Merge confirmation was consumed.");
      }
      const bumped = await tx
        .update(identityAuthorityStateTable)
        .set({
          generation: sql`${identityAuthorityStateTable.generation} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(identityAuthorityStateTable.agentId, request.agentId),
            eq(identityAuthorityStateTable.generation, request.expectedGeneration)
          )
        )
        .returning();
      if (!bumped[0]) {
        fail("IDENTITY_GENERATION_CONFLICT", "Identity graph changed after confirmation.");
      }
      const sourceIds = [...plan.sourcePrincipalIds];
      await tx
        .update(identityCanonicalRedirectTable)
        .set({ status: "superseded", supersededAt: now })
        .where(
          and(
            eq(identityCanonicalRedirectTable.agentId, request.agentId),
            inArray(identityCanonicalRedirectTable.sourcePrincipalId, sourceIds),
            eq(identityCanonicalRedirectTable.status, "active")
          )
        );
      const redirectIds: UUID[] = [];
      for (const sourcePrincipalId of sourceIds) {
        const [latest] = await tx
          .select({ version: identityCanonicalRedirectTable.version })
          .from(identityCanonicalRedirectTable)
          .where(
            and(
              eq(identityCanonicalRedirectTable.agentId, request.agentId),
              eq(identityCanonicalRedirectTable.sourcePrincipalId, sourcePrincipalId)
            )
          )
          .orderBy(desc(identityCanonicalRedirectTable.version))
          .limit(1);
        const id = newId();
        redirectIds.push(id);
        await tx.insert(identityCanonicalRedirectTable).values({
          id,
          agentId: request.agentId,
          sourcePrincipalId,
          canonicalPrincipalId: plan.canonicalPrincipalId,
          mergeJournalId: journal.id,
          version: (latest?.version ?? 0) + 1,
          status: "active",
          createdAt: now,
        });
      }
      const result = {
        canonicalPrincipalId: plan.canonicalPrincipalId,
        preservedPrincipalIds: [plan.canonicalPrincipalId, ...sourceIds],
        redirectIds,
        repairedConsumers: ["identity-canonical-redirects"],
        pendingConsumers: [...PENDING_CONSUMERS],
        generation: bumped[0].generation,
      };
      const [updated] = await tx
        .update(identityMergeJournalTable)
        .set({
          status: "committed",
          commitIdempotencyKey: request.idempotencyKey,
          commitRequestDigest: request.requestDigest,
          result: toDbObject(result),
          committedAt: now,
        })
        .where(
          and(
            eq(identityMergeJournalTable.id, journal.id),
            eq(identityMergeJournalTable.status, "planned")
          )
        )
        .returning();
      if (!updated) return fail("IDENTITY_COMMIT_RACE", "Merge journal changed during commit.");
      return mapJournal(updated);
    });
  }

  async split(request: SplitIdentityRequest): Promise<MergeJournal> {
    this.assertAgent(request.agentId);
    const principalIds = [...new Set(request.principalIds)].sort();
    if (principalIds.length === 0) {
      fail("IDENTITY_SPLIT_INPUT_INVALID", "Split requires at least one principal.");
    }
    assertRequestDigest(request.requestDigest, "split", {
      agentId: request.agentId,
      parentJournalId: request.parentJournalId,
      principalIds,
      expectedGeneration: request.expectedGeneration,
      actorPrincipalId: request.actorPrincipalId,
      reason: request.reason,
      idempotencyKey: request.idempotencyKey,
    });
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(identityMergeJournalTable)
        .where(
          and(
            eq(identityMergeJournalTable.agentId, request.agentId),
            eq(identityMergeJournalTable.operation, "split"),
            eq(identityMergeJournalTable.idempotencyKey, request.idempotencyKey)
          )
        )
        .limit(1);
      if (existing) {
        if (existing.requestDigest !== request.requestDigest) {
          fail("IDENTITY_IDEMPOTENCY_CONFLICT", "Split key was reused.");
        }
        return mapJournal(existing);
      }
      const [parent] = await tx
        .select()
        .from(identityMergeJournalTable)
        .where(
          and(
            eq(identityMergeJournalTable.id, request.parentJournalId),
            eq(identityMergeJournalTable.agentId, request.agentId)
          )
        )
        .for("update")
        .limit(1);
      if (parent?.operation !== "merge" || !["committed", "completed"].includes(parent.status)) {
        fail("IDENTITY_SPLIT_PARENT_INVALID", "Split parent is not a committed merge.");
      }
      const parentSources = new Set(asUuidArray(parent.sourcePrincipalIds, "parent.sources"));
      if (!principalIds.every((id) => parentSources.has(id))) {
        fail("IDENTITY_SPLIT_SCOPE_INVALID", "Split principals are outside the parent merge.");
      }
      const active = await tx
        .select()
        .from(identityCanonicalRedirectTable)
        .where(
          and(
            eq(identityCanonicalRedirectTable.agentId, request.agentId),
            inArray(identityCanonicalRedirectTable.sourcePrincipalId, principalIds),
            eq(identityCanonicalRedirectTable.mergeJournalId, request.parentJournalId),
            eq(identityCanonicalRedirectTable.status, "active")
          )
        )
        .for("update");
      if (active.length !== principalIds.length) {
        fail("IDENTITY_SPLIT_STALE", "A principal no longer uses the parent redirect.");
      }
      const now = new Date();
      const journalId = newId();
      const expiresAt = new Date(now.getTime() + PLAN_TTL_MS);
      const plan: IdentityMergePlan = {
        contractVersion: 1,
        id: journalId,
        agentId: request.agentId,
        operation: "split",
        canonicalPrincipalId: parent.canonicalPrincipalId as UUID,
        sourcePrincipalIds: principalIds,
        parentJournalId: request.parentJournalId,
        expectedGeneration: request.expectedGeneration,
        affectedReferences: active.map((row) => ({
          consumer: "identity-canonical-redirects",
          referenceType: "redirect",
          referenceId: row.id,
          principalId: row.sourcePrincipalId as UUID,
          resolution: "redirect_safe",
        })),
        conflictingClaims: [],
        createdAt: iso(now),
        expiresAt: iso(expiresAt),
      };
      const planDigest = digest("elizaos:identity:merge-plan:v1", plan);
      await tx.insert(identityMergeJournalTable).values({
        id: journalId,
        agentId: request.agentId,
        operation: "split",
        status: "planned",
        parentJournalId: request.parentJournalId,
        actorPrincipalId: request.actorPrincipalId,
        canonicalPrincipalId: parent.canonicalPrincipalId,
        idempotencyKey: request.idempotencyKey,
        requestDigest: request.requestDigest,
        planDigest,
        expiresAt,
        expectedGeneration: request.expectedGeneration,
        sourcePrincipalIds: principalIds,
        plan: toDbObject(plan),
        beforeState: toDbObject({
          generation: request.expectedGeneration,
          redirects: active.map(mapRedirect),
        }),
        reason: request.reason,
      });
      const bumped = await tx
        .update(identityAuthorityStateTable)
        .set({ generation: sql`${identityAuthorityStateTable.generation} + 1`, updatedAt: now })
        .where(
          and(
            eq(identityAuthorityStateTable.agentId, request.agentId),
            eq(identityAuthorityStateTable.generation, request.expectedGeneration)
          )
        )
        .returning();
      if (!bumped[0])
        return fail("IDENTITY_GENERATION_CONFLICT", "Identity graph changed before split.");
      await tx
        .update(identityCanonicalRedirectTable)
        .set({ status: "reverted", supersededAt: now })
        .where(
          and(
            eq(identityCanonicalRedirectTable.agentId, request.agentId),
            inArray(
              identityCanonicalRedirectTable.id,
              active.map((row) => row.id)
            ),
            eq(identityCanonicalRedirectTable.status, "active")
          )
        );
      const result = {
        canonicalPrincipalId: parent.canonicalPrincipalId as UUID,
        preservedPrincipalIds: [parent.canonicalPrincipalId as UUID, ...principalIds],
        redirectIds: active.map((row) => row.id as UUID),
        repairedConsumers: ["identity-canonical-redirects"],
        pendingConsumers: [...PENDING_CONSUMERS],
        generation: bumped[0].generation,
      };
      const [updated] = await tx
        .update(identityMergeJournalTable)
        .set({ status: "committed", result: toDbObject(result), committedAt: now })
        .where(eq(identityMergeJournalTable.id, journalId))
        .returning();
      if (!updated) return fail("IDENTITY_SPLIT_COMMIT_FAILED", "Split did not commit.");
      return mapJournal(updated);
    });
  }

  async getJournal(agentId: UUID, journalId: UUID): Promise<MergeJournal | null> {
    this.assertAgent(agentId);
    const [row] = await this.db
      .select()
      .from(identityMergeJournalTable)
      .where(
        and(
          eq(identityMergeJournalTable.agentId, agentId),
          eq(identityMergeJournalTable.id, journalId)
        )
      )
      .limit(1);
    return row ? mapJournal(row) : null;
  }

  async listRedirects(
    agentId: UUID,
    principalId: UUID
  ): Promise<readonly IdentityCanonicalRedirect[]> {
    this.assertAgent(agentId);
    const rows = await this.db
      .select()
      .from(identityCanonicalRedirectTable)
      .where(
        and(
          eq(identityCanonicalRedirectTable.agentId, agentId),
          or(
            eq(identityCanonicalRedirectTable.sourcePrincipalId, principalId),
            eq(identityCanonicalRedirectTable.canonicalPrincipalId, principalId)
          )
        )
      )
      .orderBy(desc(identityCanonicalRedirectTable.version));
    return rows.map(mapRedirect);
  }

  async listJournal(
    agentId: UUID,
    options: { limit: number; cursor: string | null }
  ): Promise<IdentityJournalPage> {
    this.assertAgent(agentId);
    const limit = Math.min(MAX_JOURNAL_PAGE, Math.max(1, Math.trunc(options.limit)));
    let cursorDate: Date | null = null;
    let cursorId: UUID | null = null;
    if (options.cursor) {
      const splitAt = options.cursor.indexOf("|");
      cursorDate = new Date(options.cursor.slice(0, splitAt));
      cursorId = options.cursor.slice(splitAt + 1) as UUID;
      if (splitAt < 1 || !Number.isFinite(cursorDate.getTime()) || !cursorId) {
        fail("IDENTITY_CURSOR_INVALID", "Journal cursor is invalid.");
      }
    }
    const predicate =
      cursorDate && cursorId
        ? and(
            eq(identityMergeJournalTable.agentId, agentId),
            or(
              lt(identityMergeJournalTable.createdAt, cursorDate),
              and(
                eq(identityMergeJournalTable.createdAt, cursorDate),
                lt(identityMergeJournalTable.id, cursorId)
              )
            )
          )
        : eq(identityMergeJournalTable.agentId, agentId);
    const rows = await this.db
      .select()
      .from(identityMergeJournalTable)
      .where(predicate)
      .orderBy(desc(identityMergeJournalTable.createdAt), desc(identityMergeJournalTable.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(mapJournal),
      nextCursor: rows.length > limit && last ? `${iso(last.createdAt)}|${last.id}` : null,
    };
  }
}
