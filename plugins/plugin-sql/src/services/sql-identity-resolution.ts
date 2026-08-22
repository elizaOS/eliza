/**
 * SQL-backed canonical identity authority. Authenticated person-link evidence,
 * merge, and split serialize through the per-agent generation row. Claim and
 * attestation evidence is append-only; versioned redirects keep source
 * principals intact while consumer projections repair.
 */
import {
  type AttestIdentityPersonLinkRequest,
  type CommitIdentityMergeRequest,
  type DisputeIdentityClaimRequest,
  ElizaError,
  type IAgentRuntime,
  IDENTITY_AUTHORITY_CONTRACT_VERSION,
  type IdentityCanonicalRedirect,
  type IdentityCanonicalResolution,
  type IdentityClaim,
  type IdentityClaimConflict,
  type IdentityClaimEventKind,
  type IdentityClaimJournalEntry,
  type IdentityClaimJournalPage,
  type IdentityClaimScope,
  type IdentityCluster,
  type IdentityJournalPage,
  type IdentityMergeConfirmation,
  type IdentityMergePlan,
  type IdentityMigrationInventory,
  type IdentityPersonLinkAttestation,
  type IdentityPersonLinkVerification,
  IdentityResolutionService,
  type JsonObject,
  type MergeJournal,
  type ObserveIdentityClaimRequest,
  type OwnerBindingEvaluation,
  type ProposeIdentityMergeRequest,
  type RevokeIdentityClaimRequest,
  type Service,
  type SplitIdentityRequest,
  type UUID,
  type VerifyIdentityClaimRequest,
  type VerifyIdentityPersonLinkRequest,
} from "@elizaos/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { entityTable } from "../schema/entity";
import {
  identityAuthorityStateTable,
  identityCanonicalRedirectTable,
  identityClaimJournalTable,
  identityClaimTable,
  identityMergeConfirmationTable,
  identityMergeJournalTable,
  identityPersonLinkAttestationTable,
} from "../schema/identityAuthority";
import { type DrizzleDatabase, getDb } from "../types";
import { inspectSqlIdentityMigration } from "./sql-identity-migration-inventory";

const PLAN_TTL_MS = 15 * 60_000;
const CONFIRMATION_TTL_MS = 5 * 60_000;
const MAX_JOURNAL_PAGE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_INSTANT_PATTERN =
  /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
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
type PersonLinkAttestationRow = typeof identityPersonLinkAttestationTable.$inferSelect;
type ClaimJournalRow = typeof identityClaimJournalTable.$inferSelect;
type VersionedIdentityClaim = IdentityClaim & { version: number };

function fail(code: string, message: string, context: Record<string, unknown> = {}): never {
  throw new ElizaError(message, { code, context, severity: "fatal" });
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_INSTANT_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
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

export type IdentityRequestDigestOperation =
  | "propose-merge"
  | "commit-merge"
  | "split"
  | "observe-claim"
  | "verify-claim"
  | "dispute-claim"
  | "revoke-claim";

function canonicalizeIdentityRequest(
  operation: IdentityRequestDigestOperation,
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
  operation: IdentityRequestDigestOperation,
  value: JsonObject
): string {
  return digest(`elizaos:identity:${operation}:v1`, canonicalizeIdentityRequest(operation, value));
}

function normalizePersonLinkPair(left: UUID, right: UUID): readonly [UUID, UUID] {
  if (left === right) {
    fail("IDENTITY_PERSON_LINK_INPUT_INVALID", "Person-link principals must be distinct.");
  }
  return left < right ? [left, right] : [right, left];
}

export function computeIdentityPersonLinkRequestDigest(
  value: Omit<AttestIdentityPersonLinkRequest, "requestDigest">
): string {
  const [leftPrincipalId, rightPrincipalId] = normalizePersonLinkPair(
    value.leftPrincipalId,
    value.rightPrincipalId
  );
  return digest("elizaos:identity:person-link-attestation:v1", {
    ...value,
    leftPrincipalId,
    rightPrincipalId,
  });
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

function mapPersonLinkAttestation(row: PersonLinkAttestationRow): IdentityPersonLinkAttestation {
  return {
    contractVersion: IDENTITY_AUTHORITY_CONTRACT_VERSION,
    id: row.id as UUID,
    agentId: row.agentId as UUID,
    leftPrincipalId: row.leftPrincipalId as UUID,
    rightPrincipalId: row.rightPrincipalId as UUID,
    actorPrincipalId: row.actorPrincipalId as UUID,
    actorRole: row.actorRole as IdentityPersonLinkAttestation["actorRole"],
    authority: "authenticated_private_route",
    transport: row.transport as IdentityPersonLinkAttestation["transport"],
    reason: row.reason,
    idempotencyKey: row.idempotencyKey,
    requestDigest: row.requestDigest,
    expectedGeneration: row.expectedGeneration,
    committedGeneration: row.committedGeneration,
    createdAt: iso(row.createdAt),
  };
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

function mapClaim(row: ClaimRow): VersionedIdentityClaim {
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
    version: row.version,
    ownerBindingId: row.ownerBindingId,
    verificationAuthorityKind:
      row.verificationAuthorityKind as IdentityClaim["verificationAuthorityKind"],
    verificationAuthorityId: row.verificationAuthorityId,
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

function mapClaimJournal(
  row: ClaimJournalRow
): IdentityClaimJournalEntry & { afterClaim: VersionedIdentityClaim } {
  return {
    contractVersion: 1,
    id: row.id as UUID,
    agentId: row.agentId as UUID,
    claimId: row.claimId as UUID,
    principalEntityId: row.principalEntityId as UUID,
    eventKind: row.eventKind as IdentityClaimEventKind,
    priorVersion: row.priorVersion,
    resultingVersion: row.resultingVersion,
    actorPrincipalId: row.actorPrincipalId as UUID,
    idempotencyKey: row.idempotencyKey,
    requestDigest: row.requestDigest,
    reason: row.reason,
    provenance: asJsonObject(row.provenance, "claimJournal.provenance"),
    evidence: asJsonObject(row.evidence, "claimJournal.evidence"),
    beforeClaim: row.beforeClaim
      ? (asJsonObject(row.beforeClaim, "claimJournal.beforeClaim") as unknown as IdentityClaim)
      : null,
    afterClaim: asJsonObject(
      row.afterClaim,
      "claimJournal.afterClaim"
    ) as unknown as VersionedIdentityClaim,
    createdAt: iso(row.createdAt),
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
          eq(identityClaimTable.status, "active")
        )
      )
      .limit(1);
    return row ? mapClaim(row) : null;
  }

  async observeClaim(request: ObserveIdentityClaimRequest): Promise<IdentityClaim> {
    this.assertAgent(request.agentId);
    const requestValue = {
      agentId: request.agentId,
      actorPrincipalId: request.actorPrincipalId,
      principalEntityId: request.principalEntityId,
      scope: request.scope,
      handle: request.handle,
      displayName: request.displayName,
      confidence: request.confidence,
      observedAt: request.observedAt,
      idempotencyKey: request.idempotencyKey,
      reason: request.reason,
      provenance: request.provenance,
      evidence: request.evidence,
    };
    assertRequestDigest(request.requestDigest, "observe-claim", requestValue);
    if (
      !isCanonicalInstant(request.observedAt) ||
      !Number.isFinite(request.confidence) ||
      request.confidence < 0 ||
      request.confidence > 1 ||
      typeof request.idempotencyKey !== "string" ||
      request.idempotencyKey.trim().length === 0 ||
      typeof request.reason !== "string" ||
      request.reason.trim().length === 0 ||
      typeof request.scope.namespace !== "string" ||
      request.scope.namespace.trim().length === 0 ||
      typeof request.scope.connectorId !== "string" ||
      request.scope.connectorId.trim().length === 0 ||
      typeof request.scope.externalSubjectId !== "string" ||
      request.scope.externalSubjectId.trim().length === 0
    ) {
      fail("IDENTITY_CLAIM_INPUT_INVALID", "Claim observation input is invalid.");
    }
    // A connected transport account is not authority to bind an arbitrary
    // subject to a principal. Observation stays dormant until a connector
    // producer can present a capability-bound, tenant-scoped receipt.
    fail(
      "IDENTITY_CLAIM_OBSERVATION_AUTHORITY_UNAVAILABLE",
      "Identity claim observation requires a trusted connector producer."
    );
  }

  private async transitionClaim(
    request: VerifyIdentityClaimRequest | DisputeIdentityClaimRequest | RevokeIdentityClaimRequest,
    eventKind: "verified" | "disputed" | "revoked"
  ): Promise<IdentityClaim> {
    this.assertAgent(request.agentId);
    const suppliedAuthority = (request as unknown as { authority?: unknown }).authority;
    if (suppliedAuthority !== undefined) {
      fail("IDENTITY_CLAIM_INPUT_INVALID", "Caller-supplied claim authority is not accepted.");
    }
    const operation =
      `${eventKind === "verified" ? "verify" : eventKind === "disputed" ? "dispute" : "revoke"}-claim` as const;
    const requestValue: JsonObject = {
      agentId: request.agentId,
      actorPrincipalId: request.actorPrincipalId,
      claimId: request.claimId,
      expectedVersion: request.expectedVersion,
      idempotencyKey: request.idempotencyKey,
      reason: request.reason,
      provenance: request.provenance,
      evidence: request.evidence,
      ...(eventKind === "verified"
        ? {
            verifiedAt: (request as VerifyIdentityClaimRequest).verifiedAt,
          }
        : {}),
      ...(eventKind === "revoked"
        ? { revokedAt: (request as RevokeIdentityClaimRequest).revokedAt }
        : {}),
    };
    assertRequestDigest(request.requestDigest, operation, requestValue);
    if (
      !Number.isInteger(request.expectedVersion) ||
      request.expectedVersion < 1 ||
      typeof request.idempotencyKey !== "string" ||
      request.idempotencyKey.trim().length === 0 ||
      typeof request.reason !== "string" ||
      request.reason.trim().length === 0
    ) {
      fail("IDENTITY_CLAIM_INPUT_INVALID", "Claim transition input is invalid.");
    }
    const transitionTimestamp =
      eventKind === "verified"
        ? (request as VerifyIdentityClaimRequest).verifiedAt
        : eventKind === "revoked"
          ? (request as RevokeIdentityClaimRequest).revokedAt
          : null;
    if (transitionTimestamp !== null && !isCanonicalInstant(transitionTimestamp)) {
      fail("IDENTITY_CLAIM_INPUT_INVALID", "Claim transition timestamp is invalid.");
    }
    if (eventKind === "verified") {
      fail(
        "IDENTITY_VERIFICATION_AUTHORITY_UNAVAILABLE",
        "No capability-bound identity verification producer is registered."
      );
    }
    fail(
      "IDENTITY_ADMIN_AUTHORITY_UNAVAILABLE",
      "No authenticated identity administration producer is registered."
    );
  }

  async verifyClaim(request: VerifyIdentityClaimRequest): Promise<IdentityClaim> {
    return this.transitionClaim(request, "verified");
  }

  async disputeClaim(request: DisputeIdentityClaimRequest): Promise<IdentityClaim> {
    return this.transitionClaim(request, "disputed");
  }

  async revokeClaim(request: RevokeIdentityClaimRequest): Promise<IdentityClaim> {
    return this.transitionClaim(request, "revoked");
  }

  async listClaimJournal(
    agentId: UUID,
    claimId: UUID,
    options: { limit: number; cursor: string | null }
  ): Promise<IdentityClaimJournalPage> {
    this.assertAgent(agentId);
    if (!Number.isFinite(options.limit) || options.limit < 1) {
      fail("IDENTITY_JOURNAL_LIMIT_INVALID", "Claim journal limit must be a positive number.");
    }
    if (
      options.cursor !== null &&
      (typeof options.cursor !== "string" || !UUID_PATTERN.test(options.cursor))
    ) {
      fail("IDENTITY_JOURNAL_CURSOR_INVALID", "Claim journal cursor is invalid.");
    }
    const limit = Math.max(1, Math.min(MAX_JOURNAL_PAGE, Math.floor(options.limit)));
    const conditions = [
      eq(identityClaimJournalTable.agentId, agentId),
      eq(identityClaimJournalTable.claimId, claimId),
    ];
    if (options.cursor) {
      const [cursor] = await this.db
        .select({
          id: identityClaimJournalTable.id,
          createdAt: identityClaimJournalTable.createdAt,
        })
        .from(identityClaimJournalTable)
        .where(
          and(
            eq(identityClaimJournalTable.agentId, agentId),
            eq(identityClaimJournalTable.claimId, claimId),
            eq(identityClaimJournalTable.id, options.cursor as UUID)
          )
        )
        .limit(1);
      if (!cursor) fail("IDENTITY_JOURNAL_CURSOR_INVALID", "Claim journal cursor is invalid.");
      const pageCondition = or(
        lt(identityClaimJournalTable.createdAt, cursor.createdAt),
        and(
          eq(identityClaimJournalTable.createdAt, cursor.createdAt),
          lt(identityClaimJournalTable.id, cursor.id)
        )
      );
      if (!pageCondition) fail("IDENTITY_JOURNAL_CURSOR_INVALID", "Cursor cannot be applied.");
      conditions.push(pageCondition);
    }
    const rows = await this.db
      .select()
      .from(identityClaimJournalTable)
      .where(and(...conditions))
      .orderBy(desc(identityClaimJournalTable.createdAt), desc(identityClaimJournalTable.id))
      .limit(limit + 1);
    return {
      items: rows.slice(0, limit).map(mapClaimJournal),
      nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
    };
  }

  async inspectLegacyMigration(agentId: UUID): Promise<IdentityMigrationInventory> {
    this.assertAgent(agentId);
    const setting = this.runtime.getSetting("ELIZA_INSTANCE_ID");
    const instanceId = typeof setting === "string" && setting.trim() ? setting.trim() : undefined;
    return inspectSqlIdentityMigration(this.db, agentId, new Date(), instanceId);
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
    const candidates = cluster.claims.filter(
      (claim) =>
        claim.status === "active" &&
        (claim.verification === "verified" || claim.verification === "owner_bound") &&
        (connectorAccountId === undefined || claim.connectorAccountId === connectorAccountId)
    );
    const decisions = await Promise.all(
      candidates.map(async (claim) => ({
        claim,
        trusted: await this.isTrustedDeliveryClaim(agentId, claim),
      }))
    );
    return decisions.filter((decision) => decision.trusted).map((decision) => decision.claim);
  }

  private async isTrustedDeliveryClaim(agentId: UUID, claim: IdentityClaim): Promise<boolean> {
    void agentId;
    void claim;
    // Historical owner bindings do not authenticate a principal-to-owner
    // relationship, and mutable claim rows are not connector capabilities.
    // Delivery remains unavailable until an independently authenticated,
    // tenant-bound producer can prove both relationships.
    return false;
  }

  async evaluateOwnerBinding(
    request: Parameters<IdentityResolutionService["evaluateOwnerBinding"]>[0]
  ): Promise<OwnerBindingEvaluation> {
    this.assertAgent(request.agentId);
    void request;
    return { decision: "unavailable", reason: "service_unavailable" };
  }

  async attestPersonLink(
    request: AttestIdentityPersonLinkRequest
  ): Promise<IdentityPersonLinkAttestation> {
    this.assertAgent(request.agentId);
    const [leftPrincipalId, rightPrincipalId] = normalizePersonLinkPair(
      request.leftPrincipalId,
      request.rightPrincipalId
    );
    const reason = request.reason.trim();
    const idempotencyKey = request.idempotencyKey.trim();
    if (
      !Number.isSafeInteger(request.expectedGeneration) ||
      request.expectedGeneration < 0 ||
      reason.length === 0 ||
      reason.length > 500 ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > 200 ||
      (request.actorRole !== "OWNER" && request.actorRole !== "ADMIN") ||
      request.authority !== "authenticated_private_route" ||
      (request.transport !== "http" && request.transport !== "in_process")
    ) {
      fail("IDENTITY_PERSON_LINK_INPUT_INVALID", "Person-link attestation input is invalid.");
    }
    const digestInput: Omit<AttestIdentityPersonLinkRequest, "requestDigest"> = {
      agentId: request.agentId,
      leftPrincipalId,
      rightPrincipalId,
      actorPrincipalId: request.actorPrincipalId,
      actorRole: request.actorRole,
      authority: request.authority,
      transport: request.transport,
      reason,
      idempotencyKey,
      expectedGeneration: request.expectedGeneration,
    };
    const expectedDigest = computeIdentityPersonLinkRequestDigest(digestInput);
    if (request.requestDigest !== expectedDigest) {
      fail(
        "IDENTITY_REQUEST_DIGEST_MISMATCH",
        "Person-link attestation digest does not match the request."
      );
    }

    return this.db.transaction(async (tx) => {
      await tx
        .insert(identityAuthorityStateTable)
        .values({ agentId: request.agentId })
        .onConflictDoNothing();
      const [state] = await tx
        .select()
        .from(identityAuthorityStateTable)
        .where(eq(identityAuthorityStateTable.agentId, request.agentId))
        .for("update")
        .limit(1);
      if (!state) return fail("IDENTITY_STATE_MISSING", "Identity authority state is missing.");

      const [existing] = await tx
        .select()
        .from(identityPersonLinkAttestationTable)
        .where(
          and(
            eq(identityPersonLinkAttestationTable.agentId, request.agentId),
            eq(identityPersonLinkAttestationTable.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1);
      if (existing) {
        if (existing.requestDigest !== expectedDigest) {
          fail(
            "IDENTITY_IDEMPOTENCY_CONFLICT",
            "Person-link attestation key was reused for another request."
          );
        }
        return mapPersonLinkAttestation(existing);
      }
      if (state.generation !== request.expectedGeneration) {
        fail("IDENTITY_GENERATION_CONFLICT", "Identity graph changed before attestation.");
      }

      const requiredPrincipalIds = [
        ...new Set([leftPrincipalId, rightPrincipalId, request.actorPrincipalId]),
      ];
      const principals = await tx
        .select({ id: entityTable.id })
        .from(entityTable)
        .where(
          and(
            eq(entityTable.agentId, request.agentId),
            inArray(entityTable.id, requiredPrincipalIds)
          )
        );
      if (new Set(principals.map((row) => row.id)).size !== requiredPrincipalIds.length) {
        fail(
          "IDENTITY_PRINCIPAL_NOT_FOUND",
          "Both person-link principals and the authenticated actor must exist."
        );
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
      if (
        follow(leftPrincipalId, redirects).canonical ===
        follow(rightPrincipalId, redirects).canonical
      ) {
        fail(
          "IDENTITY_PERSON_LINK_ALREADY_CANONICAL",
          "Person-link principals already resolve to one canonical principal."
        );
      }

      const now = new Date();
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
        fail("IDENTITY_GENERATION_CONFLICT", "Identity graph changed before attestation.");
      }
      const [inserted] = await tx
        .insert(identityPersonLinkAttestationTable)
        .values({
          id: newId(),
          agentId: request.agentId,
          leftPrincipalId,
          rightPrincipalId,
          actorPrincipalId: request.actorPrincipalId,
          actorRole: request.actorRole,
          authority: request.authority,
          transport: request.transport,
          reason,
          idempotencyKey,
          requestDigest: expectedDigest,
          expectedGeneration: request.expectedGeneration,
          committedGeneration: bumped[0].generation,
          createdAt: now,
        })
        .returning();
      if (!inserted) {
        fail("IDENTITY_PERSON_LINK_COMMIT_FAILED", "Person-link attestation did not commit.");
      }
      return mapPersonLinkAttestation(inserted);
    });
  }

  async verifyPersonLink(
    request: VerifyIdentityPersonLinkRequest
  ): Promise<IdentityPersonLinkVerification> {
    this.assertAgent(request.agentId);
    if (!Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration < 0) {
      fail("IDENTITY_PERSON_LINK_INPUT_INVALID", "Verification generation is invalid.");
    }
    const [leftPrincipalId, rightPrincipalId] = normalizePersonLinkPair(
      request.leftPrincipalId,
      request.rightPrincipalId
    );
    return this.db.transaction(async (tx) => {
      const [state] = await tx
        .select()
        .from(identityAuthorityStateTable)
        .where(eq(identityAuthorityStateTable.agentId, request.agentId))
        .for("update")
        .limit(1);
      const generation = state?.generation ?? 0;
      if (generation !== request.expectedGeneration) {
        fail("IDENTITY_GENERATION_CONFLICT", "Identity graph changed before verification.");
      }
      const [attestation] = await tx
        .select()
        .from(identityPersonLinkAttestationTable)
        .where(
          and(
            eq(identityPersonLinkAttestationTable.agentId, request.agentId),
            eq(identityPersonLinkAttestationTable.leftPrincipalId, leftPrincipalId),
            eq(identityPersonLinkAttestationTable.rightPrincipalId, rightPrincipalId)
          )
        )
        .orderBy(
          desc(identityPersonLinkAttestationTable.createdAt),
          desc(identityPersonLinkAttestationTable.id)
        )
        .limit(1);
      return attestation
        ? {
            decision: "attested",
            generation,
            attestation: mapPersonLinkAttestation(attestation),
          }
        : { decision: "not_attested", generation, reason: "no_attestation" };
    });
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
      const canonicalAliases = new Set<UUID>();
      for (const redirect of redirects) {
        const sourcePrincipalId = redirect.sourcePrincipalId as UUID;
        if (follow(sourcePrincipalId, redirects).canonical === canonical) {
          canonicalAliases.add(sourcePrincipalId);
        }
      }
      const clusterIds = [canonical, ...canonicalAliases, ...expanded];
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
      const conflictingClaims: IdentityClaimConflict[] = [];
      if (ownerBindings.size > 1) {
        conflictingClaims.push({
          claimIds: ownerClaims.map((claim) => claim.id as UUID),
          reason: "owner_binding",
          details: { ownerBindingIds: [...ownerBindings] },
        });
      }
      const claimsByScope = new Map<string, typeof claims>();
      for (const claim of claims) {
        const key = [
          claim.namespace,
          claim.connectorId,
          claim.connectorAccountId,
          claim.externalSubjectId,
        ].join("\u0000");
        const scoped = claimsByScope.get(key) ?? [];
        scoped.push(claim);
        claimsByScope.set(key, scoped);
      }
      for (const scoped of claimsByScope.values()) {
        const principals = new Set(scoped.map((claim) => claim.principalEntityId));
        if (principals.size > 1) {
          conflictingClaims.push({
            claimIds: scoped.map((claim) => claim.id as UUID),
            reason: "scoped_subject",
            details: { principalEntityIds: [...principals] },
          });
        }
        const disputed = scoped.filter((claim) => claim.status === "disputed");
        if (disputed.length > 0) {
          conflictingClaims.push({
            claimIds: disputed.map((claim) => claim.id as UUID),
            reason: "verification",
            details: { status: "disputed" },
          });
        }
      }
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
          ...PENDING_CONSUMERS.flatMap((consumer) =>
            [...expanded].map((principalId) => ({
              consumer,
              referenceType: "principal_projection",
              referenceId: principalId,
              principalId,
              resolution: "projection_repair_required" as const,
            }))
          ),
        ],
        conflictingClaims,
        createdAt: iso(now),
        expiresAt: iso(new Date(now.getTime() + PLAN_TTL_MS)),
      };
      const planDigest = digest("elizaos:identity:merge-plan:v1", plan);
      const inserted = await tx
        .insert(identityMergeJournalTable)
        .values({
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
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return plan;
      const [winner] = await tx
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
      if (!winner || winner.requestDigest !== request.requestDigest) {
        fail("IDENTITY_IDEMPOTENCY_CONFLICT", "Proposal idempotency key was reused.");
      }
      return mapJournal(winner).plan;
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
      const inserted = await tx
        .insert(identityMergeConfirmationTable)
        .values({
          id,
          agentId: request.agentId,
          journalId: request.planId,
          actorPrincipalId: request.actorPrincipalId,
          planDigest,
          expectedGeneration: request.expectedGeneration,
          status: "active",
          confirmedAt: now,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted[0]) {
        const [winner] = await tx
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
        if (
          !winner ||
          winner.actorPrincipalId !== request.actorPrincipalId ||
          winner.expectedGeneration !== request.expectedGeneration ||
          winner.planDigest !== planDigest
        ) {
          fail("IDENTITY_CONFIRMATION_CONFLICT", "Active confirmation does not match.");
        }
        return {
          id: winner.id as UUID,
          agentId: request.agentId,
          planId: request.planId,
          expectedGeneration: winner.expectedGeneration,
          actorPrincipalId: winner.actorPrincipalId as UUID,
          planDigest: winner.planDigest,
          status: "active",
          confirmedAt: iso(winner.confirmedAt),
          expiresAt: iso(winner.expiresAt),
          consumedAt: null,
        };
      }
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
      if (journal.status === "committed" || journal.status === "completed") {
        if (
          journal.commitIdempotencyKey === request.idempotencyKey &&
          journal.commitRequestDigest === request.requestDigest
        ) {
          return mapJournal(journal);
        }
        fail("IDENTITY_IDEMPOTENCY_CONFLICT", "Merge was already committed by another request.");
      }
      if (
        journal.expiresAt <= new Date() ||
        journal.planDigest !== digest("elizaos:identity:merge-plan:v1", mapJournal(journal).plan)
      ) {
        fail("IDENTITY_PLAN_EXPIRED", "Merge plan expired or its digest changed.");
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
      const [replayed] = await tx
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
      if (replayed) {
        if (replayed.requestDigest !== request.requestDigest) {
          fail("IDENTITY_IDEMPOTENCY_CONFLICT", "Split key was reused.");
        }
        return mapJournal(replayed);
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
      const inserted = await tx
        .insert(identityMergeJournalTable)
        .values({
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
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted[0]) {
        const [winner] = await tx
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
        if (!winner || winner.requestDigest !== request.requestDigest) {
          fail("IDENTITY_IDEMPOTENCY_CONFLICT", "Split key was reused.");
        }
        return mapJournal(winner);
      }
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
