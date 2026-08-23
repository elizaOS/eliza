/**
 * SQL-backed membership authority. Registered publisher generations submit
 * bounded complete snapshots, ordered post-snapshot deltas, or point proofs;
 * every command is atomically fenced and exactly replayable.
 */
import {
  type ApplyCompleteMembershipSnapshotCommand,
  type ApplyMembershipCommand,
  ElizaError,
  EventType,
  type IAgentRuntime,
  type JsonObject,
  MEMBERSHIP_EVIDENCE_MODES,
  MEMBERSHIP_REASONS,
  MEMBERSHIP_STATES,
  type MembershipAuthorityInvalidator,
  type MembershipAuthorizationDecision,
  type MembershipEvidenceMode,
  type MembershipHealthState,
  type MembershipMutationReceipt,
  type MembershipRecord,
  type MembershipScope,
  type MembershipScopeHealth,
  MembershipService,
  type MembershipSnapshotMember,
  type RegisterMembershipPublisherCommand,
  type ReportIncompleteMembershipSnapshotCommand,
  type Service,
  type SetMembershipHealthCommand,
  type UUID,
} from "@elizaos/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { and, eq } from "drizzle-orm";
import { connectorAccountsTable } from "../schema/connectorAccounts";
import { entityTable } from "../schema/entity";
import {
  membershipAuthorityJournalTable,
  membershipAuthorityScopeTable,
  membershipAuthorityTable,
} from "../schema/membershipAuthority";
import { roomTable } from "../schema/room";
import { worldTable } from "../schema/world";
import { type DrizzleDatabase, getDb } from "../types";

const MAX_IDENTIFIER_LENGTH = 1_024;
const MAX_ROLE_LENGTH = 256;
const MAX_ROLES = 100;
const MAX_SNAPSHOT_MEMBERS = 100_000;
const MAX_VALIDITY_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_OBSERVATION_MS = 5 * 60 * 1_000;
const ACTIVE_REASONS = new Set(["joined", "reconciled_present", "permission_restored"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEGRADE_REASON = {
  stale: "authority_stale",
  unavailable: "authority_unavailable",
  unsupported: "authority_unsupported",
} as const;

type ScopeRow = typeof membershipAuthorityScopeTable.$inferSelect;
type MembershipRow = typeof membershipAuthorityTable.$inferSelect;
type Clock = () => Date;

function fail(code: string, message: string, context: Record<string, unknown> = {}): never {
  throw new ElizaError(message, { code, context, severity: "fatal" });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function assertExactKeys<T>(
  value: T,
  allowed: readonly string[],
  label: string
): asserts value is T & Record<string, unknown> {
  if (!isRecord(value)) fail("MEMBERSHIP_COMMAND_INVALID", `${label} must be a plain object.`);
  const allowedSet = new Set(allowed);
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extra.length > 0)
    fail("MEMBERSHIP_COMMAND_INVALID", `${label} contains unknown fields.`, { fields: extra });
}
function assertJson(value: unknown, path = "permissionSnapshot", seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object")
    fail("MEMBERSHIP_COMMAND_INVALID", "Permission snapshot is not valid JSON.", { path });
  if (seen.has(value))
    fail("MEMBERSHIP_COMMAND_INVALID", "Permission snapshot is cyclic.", { path });
  seen.add(value);
  if (Array.isArray(value))
    value.forEach((item, index) => {
      assertJson(item, `${path}[${index}]`, seen);
    });
  else {
    if (!isRecord(value))
      fail("MEMBERSHIP_COMMAND_INVALID", "Permission snapshot contains a non-JSON object.", {
        path,
      });
    for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}
function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value))
    fail("MEMBERSHIP_COMMAND_INVALID", "Membership command is not canonical JSON.");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}
function digest(operation: MembershipMutationReceipt["operation"], command: unknown): string {
  const bytes = sha256(
    new TextEncoder().encode(`elizaos:membership:${operation}:v1\n${stableJson(command)}`)
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function iso(value: Date): string {
  return value.toISOString();
}
function scopeWhere(scope: MembershipScope) {
  return and(
    eq(membershipAuthorityScopeTable.agentId, scope.agentId),
    eq(membershipAuthorityScopeTable.connectorId, scope.connectorId),
    eq(membershipAuthorityScopeTable.connectorAccountId, scope.connectorAccountId),
    eq(membershipAuthorityScopeTable.externalWorldId, scope.externalWorldId),
    eq(membershipAuthorityScopeTable.externalRoomId, scope.externalRoomId)
  );
}
function memberWhere(scope: MembershipScope, principalId: UUID) {
  return and(
    eq(membershipAuthorityTable.agentId, scope.agentId),
    eq(membershipAuthorityTable.connectorId, scope.connectorId),
    eq(membershipAuthorityTable.connectorAccountId, scope.connectorAccountId),
    eq(membershipAuthorityTable.externalWorldId, scope.externalWorldId),
    eq(membershipAuthorityTable.externalRoomId, scope.externalRoomId),
    eq(membershipAuthorityTable.canonicalPrincipalId, principalId)
  );
}
function allMembersWhere(scope: MembershipScope) {
  return and(
    eq(membershipAuthorityTable.agentId, scope.agentId),
    eq(membershipAuthorityTable.connectorId, scope.connectorId),
    eq(membershipAuthorityTable.connectorAccountId, scope.connectorAccountId),
    eq(membershipAuthorityTable.externalWorldId, scope.externalWorldId),
    eq(membershipAuthorityTable.externalRoomId, scope.externalRoomId)
  );
}
function mapScope(row: ScopeRow): MembershipScopeHealth {
  if (!["current", "stale", "unavailable", "unsupported"].includes(row.health))
    fail("MEMBERSHIP_PERSISTED_STATE_INVALID", "Persisted membership health is invalid.");
  if (
    row.evidenceMode !== null &&
    !MEMBERSHIP_EVIDENCE_MODES.includes(row.evidenceMode as MembershipEvidenceMode)
  )
    fail("MEMBERSHIP_PERSISTED_STATE_INVALID", "Persisted evidence mode is invalid.");
  if (
    row.health === "current" &&
    (row.validUntil === null ||
      row.validUntil <= row.observedAt ||
      row.validUntil.getTime() - row.observedAt.getTime() > MAX_VALIDITY_MS ||
      row.publisherInstanceId === null ||
      row.publisherGeneration === null ||
      row.evidenceMode === null ||
      row.sourceVersion < 0 ||
      row.sourceCursor === null)
  )
    fail("MEMBERSHIP_PERSISTED_STATE_INVALID", "Persisted current scope is not authoritative.");
  return {
    contractVersion: 1,
    agentId: row.agentId as UUID,
    connectorId: row.connectorId,
    connectorAccountId: row.connectorAccountId as UUID,
    externalWorldId: row.externalWorldId,
    externalRoomId: row.externalRoomId,
    health: row.health as MembershipHealthState,
    reason: row.reason,
    generation: row.generation,
    sourceVersion: row.sourceVersion,
    sourceCursor: row.sourceCursor,
    validUntil: row.validUntil ? iso(row.validUntil) : null,
    publisherInstanceId: row.publisherInstanceId,
    publisherGeneration: row.publisherGeneration,
    evidenceMode: row.evidenceMode as MembershipEvidenceMode | null,
    observedAt: iso(row.observedAt),
    updatedAt: iso(row.updatedAt),
  };
}
function mapMember(row: MembershipRow): MembershipRecord {
  if (
    !MEMBERSHIP_STATES.includes(row.state as MembershipRecord["state"]) ||
    !MEMBERSHIP_REASONS.includes(row.reason as MembershipRecord["reason"]) ||
    !MEMBERSHIP_EVIDENCE_MODES.includes(row.evidenceMode as MembershipEvidenceMode) ||
    (row.state === "active") !== ACTIVE_REASONS.has(row.reason) ||
    row.validUntil <= row.observedAt ||
    row.validUntil.getTime() - row.observedAt.getTime() > MAX_VALIDITY_MS
  )
    fail("MEMBERSHIP_PERSISTED_STATE_INVALID", "Persisted membership enum is invalid.");
  assertRoles(row.roles);
  if (!isRecord(row.permissionSnapshot))
    fail("MEMBERSHIP_PERSISTED_STATE_INVALID", "Persisted permission snapshot is not an object.");
  assertJson(row.permissionSnapshot);
  return {
    contractVersion: 1,
    agentId: row.agentId as UUID,
    connectorId: row.connectorId,
    connectorAccountId: row.connectorAccountId as UUID,
    externalWorldId: row.externalWorldId,
    externalRoomId: row.externalRoomId,
    canonicalPrincipalId: row.canonicalPrincipalId as UUID,
    state: row.state as MembershipRecord["state"],
    reason: row.reason as MembershipRecord["reason"],
    roles: row.roles,
    permissionSnapshot: row.permissionSnapshot as JsonObject,
    runtime: {
      worldId: row.runtimeWorldId as UUID | null,
      roomId: row.runtimeRoomId as UUID | null,
      entityId: row.runtimeEntityId as UUID | null,
    },
    publisherInstanceId: row.publisherInstanceId,
    publisherGeneration: row.publisherGeneration,
    evidenceMode: row.evidenceMode as MembershipEvidenceMode,
    generation: row.generation,
    sourceVersion: row.sourceVersion,
    sourceCursor: row.sourceCursor,
    observedAt: iso(row.observedAt),
    validUntil: iso(row.validUntil),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
function assertRoles(roles: unknown): asserts roles is string[] {
  if (
    !Array.isArray(roles) ||
    roles.length > MAX_ROLES ||
    new Set(roles).size !== roles.length ||
    roles.some(
      (role) =>
        typeof role !== "string" || role.trim().length === 0 || role.length > MAX_ROLE_LENGTH
    )
  )
    fail("MEMBERSHIP_COMMAND_INVALID", "Membership roles are invalid.");
}

function assertUuid(value: unknown, field: string, nullable = false): asserts value is UUID | null {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !UUID_PATTERN.test(value))
    fail("MEMBERSHIP_COMMAND_INVALID", `Membership ${field} is not a UUID.`);
}

export class SqlMembershipService extends MembershipService {
  static override readonly serviceType = MembershipService.serviceType;
  private readonly invalidators = new Set<MembershipAuthorityInvalidator>();
  constructor(
    runtime?: IAgentRuntime,
    private readonly clock: Clock = () => new Date()
  ) {
    super(runtime);
  }
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new SqlMembershipService(runtime);
    service.db;
    return service;
  }
  async stop(): Promise<void> {
    this.invalidators.clear();
  }
  private get db(): DrizzleDatabase {
    const db = getDb(this.runtime.adapter);
    if (!db)
      fail(
        "MEMBERSHIP_SQL_ADAPTER_REQUIRED",
        "SQL membership authority requires a Drizzle-backed adapter."
      );
    return db;
  }
  registerInvalidator(invalidator: MembershipAuthorityInvalidator): () => void {
    this.invalidators.add(invalidator);
    return () => this.invalidators.delete(invalidator);
  }

  private assertScope(scope: MembershipScope): void {
    assertExactKeys(
      scope,
      ["agentId", "connectorId", "connectorAccountId", "externalWorldId", "externalRoomId"],
      "Membership scope"
    );
    if (scope.agentId !== this.runtime.agentId)
      fail("MEMBERSHIP_TENANT_MISMATCH", "Membership request is outside this runtime tenant.");
    assertUuid(scope.agentId, "agentId");
    assertUuid(scope.connectorAccountId, "connectorAccountId");
    for (const [field, value] of Object.entries({
      connectorId: scope.connectorId,
      externalWorldId: scope.externalWorldId,
      externalRoomId: scope.externalRoomId,
    }))
      if (
        typeof value !== "string" ||
        value.trim().length === 0 ||
        value.length > MAX_IDENTIFIER_LENGTH
      )
        fail("MEMBERSHIP_COMMAND_INVALID", `Membership ${field} is invalid.`);
  }
  private assertBase(
    command: MembershipScope & {
      expectedGeneration: number;
      idempotencyKey: string;
      observedAt: string;
    },
    keys: readonly string[]
  ): Date {
    assertExactKeys(command, keys, "Membership command");
    this.assertScope({
      agentId: command.agentId,
      connectorId: command.connectorId,
      connectorAccountId: command.connectorAccountId,
      externalWorldId: command.externalWorldId,
      externalRoomId: command.externalRoomId,
    });
    if (
      !Number.isSafeInteger(command.expectedGeneration) ||
      command.expectedGeneration < 0 ||
      command.expectedGeneration === Number.MAX_SAFE_INTEGER
    )
      fail("MEMBERSHIP_COMMAND_INVALID", "Expected generation is invalid.");
    if (
      typeof command.idempotencyKey !== "string" ||
      command.idempotencyKey.trim().length === 0 ||
      command.idempotencyKey.length > MAX_IDENTIFIER_LENGTH
    )
      fail("MEMBERSHIP_COMMAND_INVALID", "Idempotency key is invalid.");
    if (typeof command.observedAt !== "string")
      fail("MEMBERSHIP_COMMAND_INVALID", "Observed timestamp must be a string.");
    const observed = new Date(command.observedAt);
    if (
      !Number.isFinite(observed.getTime()) ||
      observed.getTime() > this.clock().getTime() + MAX_FUTURE_OBSERVATION_MS
    )
      fail("MEMBERSHIP_COMMAND_INVALID", "Observed timestamp is invalid.");
    return observed;
  }
  private assertPublisher(binding: {
    publisherInstanceId: string;
    publisherGeneration: number;
    evidenceMode: MembershipEvidenceMode;
  }): void {
    if (
      typeof binding.publisherInstanceId !== "string" ||
      binding.publisherInstanceId.trim().length === 0 ||
      binding.publisherInstanceId.length > MAX_IDENTIFIER_LENGTH ||
      !Number.isSafeInteger(binding.publisherGeneration) ||
      binding.publisherGeneration < 0 ||
      !MEMBERSHIP_EVIDENCE_MODES.includes(binding.evidenceMode)
    )
      fail("MEMBERSHIP_COMMAND_INVALID", "Publisher binding is invalid.");
  }
  private assertEvidence(
    command: ApplyMembershipCommand | ApplyCompleteMembershipSnapshotCommand,
    observed: Date
  ): Date {
    this.assertPublisher(command);
    if (
      !Number.isSafeInteger(command.sourceVersion) ||
      command.sourceVersion < 0 ||
      typeof command.sourceCursor !== "string" ||
      command.sourceCursor.trim().length === 0 ||
      command.sourceCursor.length > MAX_IDENTIFIER_LENGTH ||
      (command.previousSourceCursor !== null &&
        (typeof command.previousSourceCursor !== "string" ||
          command.previousSourceCursor.length > MAX_IDENTIFIER_LENGTH))
    )
      fail("MEMBERSHIP_COMMAND_INVALID", "Evidence cursor or version is invalid.");
    if (typeof command.validUntil !== "string")
      fail("MEMBERSHIP_COMMAND_INVALID", "Evidence validity must be a string.");
    const validUntil = new Date(command.validUntil);
    const now = this.clock().getTime();
    if (
      !Number.isFinite(validUntil.getTime()) ||
      validUntil <= observed ||
      validUntil.getTime() <= now ||
      validUntil.getTime() > now + MAX_VALIDITY_MS ||
      validUntil.getTime() - observed.getTime() > MAX_VALIDITY_MS
    )
      fail("MEMBERSHIP_COMMAND_INVALID", "Evidence validity is invalid.");
    return validUntil;
  }
  private assertMember(member: MembershipSnapshotMember | ApplyMembershipCommand): void {
    assertRoles(member.roles);
    if (!isRecord(member.permissionSnapshot))
      fail("MEMBERSHIP_COMMAND_INVALID", "Permission snapshot must be a JSON object.");
    assertJson(member.permissionSnapshot);
    assertExactKeys(
      member.runtime,
      ["worldId", "roomId", "entityId"],
      "Membership runtime mapping"
    );
    assertUuid(member.canonicalPrincipalId, "canonicalPrincipalId");
    assertUuid(member.runtime.worldId, "runtime.worldId", true);
    assertUuid(member.runtime.roomId, "runtime.roomId", true);
    assertUuid(member.runtime.entityId, "runtime.entityId", true);
  }
  private async assertAccount(tx: DrizzleDatabase, scope: MembershipScope): Promise<void> {
    const [account] = await tx
      .select({ provider: connectorAccountsTable.provider })
      .from(connectorAccountsTable)
      .where(
        and(
          eq(connectorAccountsTable.id, scope.connectorAccountId),
          eq(connectorAccountsTable.agentId, scope.agentId)
        )
      )
      .limit(1);
    if (!account || account.provider !== scope.connectorId)
      fail(
        "MEMBERSHIP_CONNECTOR_ACCOUNT_MISMATCH",
        "Connector account does not match the connector and tenant."
      );
  }
  private async assertMembers(
    tx: DrizzleDatabase,
    scope: MembershipScope,
    members: readonly MembershipSnapshotMember[]
  ): Promise<void> {
    const entityIds = new Set<UUID>();
    const roomIds = new Set<UUID>();
    const worldIds = new Set<UUID>();
    for (const member of members) {
      entityIds.add(member.canonicalPrincipalId);
      if (member.runtime.entityId) entityIds.add(member.runtime.entityId);
      if (member.runtime.roomId) roomIds.add(member.runtime.roomId);
      if (member.runtime.worldId) worldIds.add(member.runtime.worldId);
    }
    const entities = await Promise.all(
      [...entityIds].map((id) =>
        tx
          .select({ id: entityTable.id })
          .from(entityTable)
          .where(and(eq(entityTable.id, id), eq(entityTable.agentId, scope.agentId)))
          .limit(1)
      )
    );
    if (entities.some((rows) => rows.length !== 1))
      fail(
        "MEMBERSHIP_PRINCIPAL_NOT_FOUND",
        "Membership principal or runtime entity does not exist in this tenant."
      );
    const rooms = await Promise.all(
      [...roomIds].map((id) =>
        tx
          .select({ id: roomTable.id })
          .from(roomTable)
          .where(and(eq(roomTable.id, id), eq(roomTable.agentId, scope.agentId)))
          .limit(1)
      )
    );
    const worlds = await Promise.all(
      [...worldIds].map((id) =>
        tx
          .select({ id: worldTable.id })
          .from(worldTable)
          .where(and(eq(worldTable.id, id), eq(worldTable.agentId, scope.agentId)))
          .limit(1)
      )
    );
    if (rooms.some((rows) => rows.length !== 1) || worlds.some((rows) => rows.length !== 1))
      fail("MEMBERSHIP_RUNTIME_MAPPING_INVALID", "Membership runtime mapping is invalid.");
  }
  private async replay(
    tx: DrizzleDatabase,
    command: MembershipScope & { idempotencyKey: string },
    requestDigest: string
  ): Promise<MembershipMutationReceipt | null> {
    const [row] = await tx
      .select()
      .from(membershipAuthorityJournalTable)
      .where(
        and(
          eq(membershipAuthorityJournalTable.agentId, command.agentId),
          eq(membershipAuthorityJournalTable.connectorAccountId, command.connectorAccountId),
          eq(membershipAuthorityJournalTable.idempotencyKey, command.idempotencyKey)
        )
      )
      .limit(1);
    if (!row) return null;
    if (row.requestDigest !== requestDigest)
      fail("MEMBERSHIP_IDEMPOTENCY_CONFLICT", "Membership idempotency key was reused.");
    const result = row.result as Partial<MembershipMutationReceipt>;
    if (
      result.contractVersion !== 1 ||
      result.committedGeneration !== row.committedGeneration ||
      !["publisher", "snapshot", "membership", "health"].includes(result.operation ?? "")
    )
      fail("MEMBERSHIP_JOURNAL_INVALID", "Persisted membership receipt is invalid.");
    return { ...result, idempotentReplay: true } as MembershipMutationReceipt;
  }
  private async row(tx: DrizzleDatabase, scope: MembershipScope): Promise<ScopeRow> {
    const [row] = await tx
      .select()
      .from(membershipAuthorityScopeTable)
      .where(scopeWhere(scope))
      .limit(1);
    if (!row) fail("MEMBERSHIP_SCOPE_WRITE_FAILED", "Membership scope is absent.");
    return row;
  }
  private async record(
    tx: DrizzleDatabase,
    operation: MembershipMutationReceipt["operation"],
    command: MembershipScope & { idempotencyKey: string; expectedGeneration: number },
    requestDigest: string,
    receipt: MembershipMutationReceipt
  ): Promise<void> {
    await tx.insert(membershipAuthorityJournalTable).values({
      agentId: command.agentId,
      connectorId: command.connectorId,
      connectorAccountId: command.connectorAccountId,
      externalWorldId: command.externalWorldId,
      externalRoomId: command.externalRoomId,
      operation,
      idempotencyKey: command.idempotencyKey,
      requestDigest,
      expectedGeneration: command.expectedGeneration,
      committedGeneration: receipt.committedGeneration,
      result: JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>,
    });
  }
  private async advanceEvidence(
    tx: DrizzleDatabase,
    command: ApplyMembershipCommand | ApplyCompleteMembershipSnapshotCommand,
    observed: Date,
    validUntil: Date,
    requestDigest: string
  ): Promise<{ scope: ScopeRow } | { replay: MembershipMutationReceipt }> {
    const current = await this.row(tx, command);
    if (current.generation !== command.expectedGeneration) {
      const replay = await this.replay(tx, command, requestDigest);
      if (replay) return { replay };
      fail("MEMBERSHIP_GENERATION_MISMATCH", "Membership scope generation changed.", {
        actualGeneration: current.generation,
      });
    }
    if (
      current.publisherInstanceId !== command.publisherInstanceId ||
      current.publisherGeneration !== command.publisherGeneration ||
      current.evidenceMode !== command.evidenceMode
    )
      fail(
        "MEMBERSHIP_PUBLISHER_MISMATCH",
        "Evidence does not match the registered publisher generation and mode."
      );
    if (
      command.evidenceMode === "ordered_delta" &&
      "state" in command &&
      (current.health !== "current" ||
        !current.sourceCursor ||
        !current.validUntil ||
        current.validUntil.getTime() <= this.clock().getTime())
    )
      fail(
        "MEMBERSHIP_SNAPSHOT_REQUIRED",
        "Ordered deltas require a current complete snapshot in this publisher generation."
      );
    if (
      command.sourceVersion !== current.sourceVersion + 1 ||
      command.previousSourceCursor !== current.sourceCursor
    )
      fail(
        "MEMBERSHIP_CURSOR_DISCONTINUITY",
        "Membership evidence is not the next durable cursor."
      );
    const [advanced] = await tx
      .update(membershipAuthorityScopeTable)
      .set({
        generation: current.generation + 1,
        sourceVersion: command.sourceVersion,
        sourceCursor: command.sourceCursor,
        validUntil,
        health: "current",
        reason: command.evidenceMode === "point_query" ? "point_query_proof" : "complete_evidence",
        observedAt: observed,
        updatedAt: this.clock(),
      })
      .where(
        and(scopeWhere(command), eq(membershipAuthorityScopeTable.generation, current.generation))
      )
      .returning();
    if (!advanced) {
      const replay = await this.replay(tx, command, requestDigest);
      if (replay) return { replay };
      fail("MEMBERSHIP_GENERATION_MISMATCH", "Concurrent membership command committed first.");
    }
    return { scope: advanced };
  }
  private async upsertMember(
    tx: DrizzleDatabase,
    scope: ScopeRow,
    member: MembershipSnapshotMember,
    state: "active" | "revoked",
    reason: MembershipRecord["reason"],
    observed: Date,
    validUntil: Date
  ): Promise<MembershipRecord> {
    const now = this.clock();
    if (
      scope.publisherInstanceId === null ||
      scope.publisherGeneration === null ||
      scope.evidenceMode === null ||
      scope.sourceCursor === null
    ) {
      fail(
        "MEMBERSHIP_PERSISTED_STATE_INVALID",
        "Current scope has incomplete publisher evidence."
      );
    }
    const publisherInstanceId = scope.publisherInstanceId;
    const publisherGeneration = scope.publisherGeneration;
    const evidenceMode = scope.evidenceMode;
    const sourceCursor = scope.sourceCursor;
    const [row] = await tx
      .insert(membershipAuthorityTable)
      .values({
        agentId: scope.agentId,
        connectorId: scope.connectorId,
        connectorAccountId: scope.connectorAccountId,
        externalWorldId: scope.externalWorldId,
        externalRoomId: scope.externalRoomId,
        canonicalPrincipalId: member.canonicalPrincipalId,
        state,
        reason,
        roles: state === "active" ? [...member.roles] : [],
        permissionSnapshot: state === "active" ? member.permissionSnapshot : {},
        runtimeWorldId: member.runtime.worldId,
        runtimeRoomId: member.runtime.roomId,
        runtimeEntityId: member.runtime.entityId,
        publisherInstanceId,
        publisherGeneration,
        evidenceMode,
        generation: scope.generation,
        sourceVersion: scope.sourceVersion,
        sourceCursor,
        observedAt: observed,
        validUntil,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          membershipAuthorityTable.agentId,
          membershipAuthorityTable.connectorId,
          membershipAuthorityTable.connectorAccountId,
          membershipAuthorityTable.externalWorldId,
          membershipAuthorityTable.externalRoomId,
          membershipAuthorityTable.canonicalPrincipalId,
        ],
        set: {
          state,
          reason,
          roles: state === "active" ? [...member.roles] : [],
          permissionSnapshot: state === "active" ? member.permissionSnapshot : {},
          runtimeWorldId: member.runtime.worldId,
          runtimeRoomId: member.runtime.roomId,
          runtimeEntityId: member.runtime.entityId,
          publisherInstanceId,
          publisherGeneration,
          evidenceMode,
          generation: scope.generation,
          sourceVersion: scope.sourceVersion,
          sourceCursor,
          observedAt: observed,
          validUntil,
          updatedAt: now,
        },
      })
      .returning();
    if (!row) fail("MEMBERSHIP_WRITE_FAILED", "Membership fact was not persisted.");
    return mapMember(row);
  }
  private async publish(scope: MembershipScope, receipt: MembershipMutationReceipt): Promise<void> {
    for (const invalidator of this.invalidators) {
      try {
        invalidator(scope, receipt);
      } catch (error) {
        // error-policy:J7 invalidator diagnostics cannot roll back committed authority.
        this.runtime.reportError("membership-authority-invalidator", error, {
          operation: receipt.operation,
        });
      }
    }
    try {
      await this.runtime.emitEvent(EventType.MEMBERSHIP_AUTHORITY_CHANGED, {
        runtime: this.runtime,
        source: "membership-authority",
        scope,
        receipt,
      });
    } catch (error) {
      // error-policy:J7 observer diagnostics cannot roll back committed authority.
      this.runtime.reportError("membership-authority-observer", error, {
        operation: receipt.operation,
      });
    }
  }

  async registerPublisher(
    command: RegisterMembershipPublisherCommand
  ): Promise<MembershipMutationReceipt> {
    const observed = this.assertBase(command, [
      "agentId",
      "connectorId",
      "connectorAccountId",
      "externalWorldId",
      "externalRoomId",
      "expectedGeneration",
      "idempotencyKey",
      "observedAt",
      "publisherInstanceId",
      "publisherGeneration",
      "evidenceMode",
    ]);
    this.assertPublisher(command);
    const requestDigest = digest("publisher", command);
    const receipt = await this.db.transaction(async (tx) => {
      const replay = await this.replay(tx, command, requestDigest);
      if (replay) return replay;
      await this.assertAccount(tx, command);
      await tx
        .insert(membershipAuthorityScopeTable)
        .values({
          agentId: command.agentId,
          connectorId: command.connectorId,
          connectorAccountId: command.connectorAccountId,
          externalWorldId: command.externalWorldId,
          externalRoomId: command.externalRoomId,
          observedAt: observed,
        })
        .onConflictDoNothing();
      const current = await this.row(tx, command);
      if (current.generation !== command.expectedGeneration) {
        const concurrentReplay = await this.replay(tx, command, requestDigest);
        if (concurrentReplay) return concurrentReplay;
        fail("MEMBERSHIP_GENERATION_MISMATCH", "Membership scope generation changed.");
      }
      if (
        current.publisherGeneration !== null &&
        command.publisherGeneration <= current.publisherGeneration
      )
        fail("MEMBERSHIP_PUBLISHER_GENERATION_STALE", "Publisher generation must advance.");
      const [advanced] = await tx
        .update(membershipAuthorityScopeTable)
        .set({
          generation: current.generation + 1,
          health: "stale",
          reason: "awaiting_publisher_evidence",
          sourceVersion: -1,
          sourceCursor: null,
          validUntil: null,
          publisherInstanceId: command.publisherInstanceId,
          publisherGeneration: command.publisherGeneration,
          evidenceMode: command.evidenceMode,
          observedAt: observed,
          updatedAt: this.clock(),
        })
        .where(
          and(scopeWhere(command), eq(membershipAuthorityScopeTable.generation, current.generation))
        )
        .returning();
      if (!advanced) {
        const concurrentReplay = await this.replay(tx, command, requestDigest);
        if (concurrentReplay) return concurrentReplay;
        fail(
          "MEMBERSHIP_GENERATION_MISMATCH",
          "Concurrent publisher registration committed first."
        );
      }
      const result: MembershipMutationReceipt = {
        contractVersion: 1,
        operation: "publisher",
        idempotentReplay: false,
        committedGeneration: advanced.generation,
        health: mapScope(advanced),
      };
      await this.record(tx, "publisher", command, requestDigest, result);
      return result;
    });
    if (!receipt.idempotentReplay) await this.publish(command, receipt);
    return receipt;
  }

  async applyCompleteSnapshot(
    command: ApplyCompleteMembershipSnapshotCommand
  ): Promise<MembershipMutationReceipt> {
    const observed = this.assertBase(command, [
      "agentId",
      "connectorId",
      "connectorAccountId",
      "externalWorldId",
      "externalRoomId",
      "expectedGeneration",
      "idempotencyKey",
      "observedAt",
      "publisherInstanceId",
      "publisherGeneration",
      "evidenceMode",
      "sourceVersion",
      "previousSourceCursor",
      "sourceCursor",
      "validUntil",
      "completeness",
      "members",
    ]);
    const validUntil = this.assertEvidence(command, observed);
    if (!["complete_snapshot", "ordered_delta"].includes(command.evidenceMode))
      fail(
        "MEMBERSHIP_COMMAND_INVALID",
        "Complete snapshots require a snapshot-capable publisher mode."
      );
    if (
      command.completeness !== "complete" ||
      !Array.isArray(command.members) ||
      command.members.length > MAX_SNAPSHOT_MEMBERS
    )
      fail(
        "MEMBERSHIP_SNAPSHOT_INCOMPLETE",
        "Only an explicitly complete bounded snapshot is authoritative."
      );
    const ids = new Set<UUID>();
    for (const member of command.members) {
      assertExactKeys(
        member,
        ["canonicalPrincipalId", "roles", "permissionSnapshot", "runtime"],
        "Snapshot member"
      );
      this.assertMember(member);
      if (ids.has(member.canonicalPrincipalId))
        fail("MEMBERSHIP_COMMAND_INVALID", "Snapshot contains duplicate principals.");
      ids.add(member.canonicalPrincipalId);
    }
    const requestDigest = digest("snapshot", command);
    const receipt = await this.db.transaction(async (tx) => {
      const replay = await this.replay(tx, command, requestDigest);
      if (replay) return replay;
      await this.assertAccount(tx, command);
      await this.assertMembers(tx, command, command.members);
      const advanced = await this.advanceEvidence(tx, command, observed, validUntil, requestDigest);
      if ("replay" in advanced) return advanced.replay;
      const { scope } = advanced;
      const existing = await tx
        .select()
        .from(membershipAuthorityTable)
        .where(allMembersWhere(command));
      const memberships: MembershipRecord[] = [];
      for (const member of command.members)
        memberships.push(
          await this.upsertMember(
            tx,
            scope,
            member,
            "active",
            "reconciled_present",
            observed,
            validUntil
          )
        );
      const revokedPrincipalIds: UUID[] = [];
      for (const old of existing)
        if (old.state === "active" && !ids.has(old.canonicalPrincipalId as UUID)) {
          revokedPrincipalIds.push(old.canonicalPrincipalId as UUID);
          await this.upsertMember(
            tx,
            scope,
            {
              canonicalPrincipalId: old.canonicalPrincipalId as UUID,
              roles: [],
              permissionSnapshot: {},
              runtime: {
                worldId: old.runtimeWorldId as UUID | null,
                roomId: old.runtimeRoomId as UUID | null,
                entityId: old.runtimeEntityId as UUID | null,
              },
            },
            "revoked",
            "reconciled_absent",
            observed,
            validUntil
          );
        }
      const result: MembershipMutationReceipt = {
        contractVersion: 1,
        operation: "snapshot",
        idempotentReplay: false,
        committedGeneration: scope.generation,
        health: mapScope(scope),
        memberships,
        revokedPrincipalIds,
      };
      await this.record(tx, "snapshot", command, requestDigest, result);
      return result;
    });
    if (!receipt.idempotentReplay) await this.publish(command, receipt);
    return receipt;
  }

  async reportIncompleteSnapshot(
    command: ReportIncompleteMembershipSnapshotCommand
  ): Promise<MembershipMutationReceipt> {
    const observed = this.assertBase(command, [
      "agentId",
      "connectorId",
      "connectorAccountId",
      "externalWorldId",
      "externalRoomId",
      "expectedGeneration",
      "idempotencyKey",
      "observedAt",
      "publisherInstanceId",
      "publisherGeneration",
      "evidenceMode",
      "completeness",
      "reason",
    ]);
    this.assertPublisher(command);
    if (
      command.completeness !== "incomplete" ||
      !["complete_snapshot", "ordered_delta"].includes(command.evidenceMode) ||
      typeof command.reason !== "string" ||
      command.reason.trim().length === 0 ||
      command.reason.length > MAX_IDENTIFIER_LENGTH
    )
      fail(
        "MEMBERSHIP_COMMAND_INVALID",
        "Incomplete snapshot reports require a snapshot-capable publisher and reason."
      );
    const requestDigest = digest("health", command);
    const receipt = await this.db.transaction(async (tx) => {
      const replay = await this.replay(tx, command, requestDigest);
      if (replay) return replay;
      await this.assertAccount(tx, command);
      const current = await this.row(tx, command);
      if (current.generation !== command.expectedGeneration) {
        const concurrentReplay = await this.replay(tx, command, requestDigest);
        if (concurrentReplay) return concurrentReplay;
        fail("MEMBERSHIP_GENERATION_MISMATCH", "Membership scope generation changed.");
      }
      if (
        current.publisherInstanceId !== command.publisherInstanceId ||
        current.publisherGeneration !== command.publisherGeneration ||
        current.evidenceMode !== command.evidenceMode
      )
        fail(
          "MEMBERSHIP_PUBLISHER_MISMATCH",
          "Incomplete snapshot does not match the registered publisher generation and mode."
        );
      const [advanced] = await tx
        .update(membershipAuthorityScopeTable)
        .set({
          generation: current.generation + 1,
          health: "stale",
          reason: command.reason,
          observedAt: observed,
          updatedAt: this.clock(),
        })
        .where(
          and(scopeWhere(command), eq(membershipAuthorityScopeTable.generation, current.generation))
        )
        .returning();
      if (!advanced) {
        const concurrentReplay = await this.replay(tx, command, requestDigest);
        if (concurrentReplay) return concurrentReplay;
        fail("MEMBERSHIP_GENERATION_MISMATCH", "Concurrent membership command committed first.");
      }
      const result: MembershipMutationReceipt = {
        contractVersion: 1,
        operation: "health",
        idempotentReplay: false,
        committedGeneration: advanced.generation,
        health: mapScope(advanced),
      };
      await this.record(tx, "health", command, requestDigest, result);
      return result;
    });
    if (!receipt.idempotentReplay) await this.publish(command, receipt);
    return receipt;
  }

  async applyMembership(command: ApplyMembershipCommand): Promise<MembershipMutationReceipt> {
    const observed = this.assertBase(command, [
      "agentId",
      "connectorId",
      "connectorAccountId",
      "externalWorldId",
      "externalRoomId",
      "expectedGeneration",
      "idempotencyKey",
      "observedAt",
      "publisherInstanceId",
      "publisherGeneration",
      "evidenceMode",
      "sourceVersion",
      "previousSourceCursor",
      "sourceCursor",
      "validUntil",
      "canonicalPrincipalId",
      "state",
      "reason",
      "roles",
      "permissionSnapshot",
      "runtime",
    ]);
    const validUntil = this.assertEvidence(command, observed);
    if (!["ordered_delta", "point_query"].includes(command.evidenceMode))
      fail(
        "MEMBERSHIP_COMMAND_INVALID",
        "Single-member evidence requires ordered-delta or point-query mode."
      );
    this.assertMember(command);
    if (
      !MEMBERSHIP_STATES.includes(command.state) ||
      !MEMBERSHIP_REASONS.includes(command.reason) ||
      (command.state === "active") !== ACTIVE_REASONS.has(command.reason)
    )
      fail("MEMBERSHIP_COMMAND_INVALID", "Membership state and reason are incompatible.");
    const requestDigest = digest("membership", command);
    const receipt = await this.db.transaction(async (tx) => {
      const replay = await this.replay(tx, command, requestDigest);
      if (replay) return replay;
      await this.assertAccount(tx, command);
      await this.assertMembers(tx, command, [command]);
      const advanced = await this.advanceEvidence(tx, command, observed, validUntil, requestDigest);
      if ("replay" in advanced) return advanced.replay;
      const { scope } = advanced;
      const membership = await this.upsertMember(
        tx,
        scope,
        command,
        command.state,
        command.reason,
        observed,
        validUntil
      );
      const result: MembershipMutationReceipt = {
        contractVersion: 1,
        operation: "membership",
        idempotentReplay: false,
        committedGeneration: scope.generation,
        membership,
      };
      await this.record(tx, "membership", command, requestDigest, result);
      return result;
    });
    if (!receipt.idempotentReplay) await this.publish(command, receipt);
    return receipt;
  }

  async setScopeHealth(command: SetMembershipHealthCommand): Promise<MembershipMutationReceipt> {
    const observed = this.assertBase(command, [
      "agentId",
      "connectorId",
      "connectorAccountId",
      "externalWorldId",
      "externalRoomId",
      "expectedGeneration",
      "idempotencyKey",
      "observedAt",
      "health",
      "reason",
    ]);
    if (
      !["stale", "unavailable", "unsupported"].includes(command.health) ||
      typeof command.reason !== "string" ||
      command.reason.trim().length === 0 ||
      command.reason.length > MAX_IDENTIFIER_LENGTH
    )
      fail("MEMBERSHIP_COMMAND_INVALID", "Health updates may only degrade authority.");
    const requestDigest = digest("health", command);
    const receipt = await this.db.transaction(async (tx) => {
      const replay = await this.replay(tx, command, requestDigest);
      if (replay) return replay;
      await this.assertAccount(tx, command);
      const current = await this.row(tx, command);
      if (current.generation !== command.expectedGeneration) {
        const concurrentReplay = await this.replay(tx, command, requestDigest);
        if (concurrentReplay) return concurrentReplay;
        fail("MEMBERSHIP_GENERATION_MISMATCH", "Membership scope generation changed.");
      }
      const [advanced] = await tx
        .update(membershipAuthorityScopeTable)
        .set({
          generation: current.generation + 1,
          health: command.health,
          reason: command.reason,
          observedAt: observed,
          updatedAt: this.clock(),
        })
        .where(
          and(scopeWhere(command), eq(membershipAuthorityScopeTable.generation, current.generation))
        )
        .returning();
      if (!advanced) {
        const concurrentReplay = await this.replay(tx, command, requestDigest);
        if (concurrentReplay) return concurrentReplay;
        fail("MEMBERSHIP_GENERATION_MISMATCH", "Concurrent health update committed first.");
      }
      const result: MembershipMutationReceipt = {
        contractVersion: 1,
        operation: "health",
        idempotentReplay: false,
        committedGeneration: advanced.generation,
        health: mapScope(advanced),
      };
      await this.record(tx, "health", command, requestDigest, result);
      return result;
    });
    if (!receipt.idempotentReplay) await this.publish(command, receipt);
    return receipt;
  }

  async getScopeHealth(scope: MembershipScope): Promise<MembershipScopeHealth | null> {
    this.assertScope(scope);
    const [row] = await this.db
      .select()
      .from(membershipAuthorityScopeTable)
      .where(scopeWhere(scope))
      .limit(1);
    return row ? mapScope(row) : null;
  }
  async getMembership(
    scope: MembershipScope,
    canonicalPrincipalId: UUID
  ): Promise<MembershipRecord | null> {
    this.assertScope(scope);
    const [row] = await this.db
      .select()
      .from(membershipAuthorityTable)
      .where(memberWhere(scope, canonicalPrincipalId))
      .limit(1);
    return row ? mapMember(row) : null;
  }
  async authorize(
    scope: MembershipScope,
    canonicalPrincipalId: UUID
  ): Promise<MembershipAuthorizationDecision> {
    this.assertScope(scope);
    assertUuid(canonicalPrincipalId, "canonicalPrincipalId");
    const [authority] = await this.db
      .select({
        scope: membershipAuthorityScopeTable,
        membership: membershipAuthorityTable,
      })
      .from(membershipAuthorityScopeTable)
      .leftJoin(
        membershipAuthorityTable,
        and(
          eq(membershipAuthorityTable.agentId, membershipAuthorityScopeTable.agentId),
          eq(membershipAuthorityTable.connectorId, membershipAuthorityScopeTable.connectorId),
          eq(
            membershipAuthorityTable.connectorAccountId,
            membershipAuthorityScopeTable.connectorAccountId
          ),
          eq(
            membershipAuthorityTable.externalWorldId,
            membershipAuthorityScopeTable.externalWorldId
          ),
          eq(membershipAuthorityTable.externalRoomId, membershipAuthorityScopeTable.externalRoomId),
          eq(membershipAuthorityTable.canonicalPrincipalId, canonicalPrincipalId)
        )
      )
      .where(scopeWhere(scope))
      .limit(1);
    if (!authority)
      return { decision: "denied", reason: "no_scope_evidence", generation: null, health: null };
    const health = mapScope(authority.scope);
    if (health.health !== "current")
      return {
        decision: "denied",
        reason: DEGRADE_REASON[health.health],
        generation: health.generation,
        health: health.health,
      };
    const now = this.clock().getTime();
    if (!health.validUntil || new Date(health.validUntil).getTime() <= now)
      return {
        decision: "denied",
        reason: "authority_expired",
        generation: health.generation,
        health: "current",
      };
    const membership = authority.membership ? mapMember(authority.membership) : null;
    if (!membership)
      return {
        decision: "denied",
        reason: "no_membership",
        generation: health.generation,
        health: "current",
      };
    if (membership.state === "revoked")
      return {
        decision: "denied",
        reason: "membership_revoked",
        generation: health.generation,
        health: "current",
      };
    if (
      membership.publisherInstanceId !== health.publisherInstanceId ||
      membership.publisherGeneration !== health.publisherGeneration ||
      membership.evidenceMode !== health.evidenceMode
    )
      return {
        decision: "denied",
        reason: "membership_evidence_mismatch",
        generation: health.generation,
        health: "current",
      };
    if (new Date(membership.validUntil).getTime() <= now)
      return {
        decision: "denied",
        reason: "membership_evidence_expired",
        generation: health.generation,
        health: "current",
      };
    return {
      decision: "allowed",
      reason: "active_membership",
      generation: health.generation,
      health: "current",
      membership,
    };
  }
}
