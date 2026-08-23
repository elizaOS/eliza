/**
 * SQL-backed canonical connector-room membership authority. Every mutation is
 * an idempotent, generation-fenced, monotonically ordered command committed to
 * the durable scope state machine before authorization caches are invalidated
 * and observers are notified.
 */
import {
  type ApplyMembershipCommand,
  ElizaError,
  EventType,
  type IAgentRuntime,
  type JsonObject,
  MEMBERSHIP_AUTHORITY_CONTRACT_VERSION,
  MEMBERSHIP_HEALTH_STATES,
  MEMBERSHIP_REASONS,
  MEMBERSHIP_STATES,
  type MembershipAuthorityInvalidator,
  type MembershipAuthorizationDecision,
  type MembershipHealthState,
  type MembershipMutationReceipt,
  type MembershipRecord,
  type MembershipScope,
  type MembershipScopeHealth,
  MembershipService,
  type Service,
  type SetMembershipHealthCommand,
  type UUID,
} from "@elizaos/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { and, eq, lt } from "drizzle-orm";
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

const MAX_ROLES = 100;
const MAX_IDENTIFIER_LENGTH = 1_024;
const ACTIVE_REASONS = new Set(["joined", "reconciled_present", "permission_restored"]);
const HEALTH_REASON_BY_STATE = {
  stale: "authority_stale",
  unavailable: "authority_unavailable",
  unsupported: "authority_unsupported",
} as const;

type ScopeRow = typeof membershipAuthorityScopeTable.$inferSelect;
type MembershipRow = typeof membershipAuthorityTable.$inferSelect;
type JournalRow = typeof membershipAuthorityJournalTable.$inferSelect;

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
    return fail("MEMBERSHIP_COMMAND_INVALID", "Membership command is not canonical JSON.");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function commandDigest(operation: "membership" | "health", command: unknown): string {
  const bytes = sha256(
    new TextEncoder().encode(`elizaos:membership:${operation}:v1\n${stableJson(command)}`)
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function iso(value: Date): string {
  return value.toISOString();
}

function mapScope(row: ScopeRow): MembershipScopeHealth {
  return {
    contractVersion: MEMBERSHIP_AUTHORITY_CONTRACT_VERSION,
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
    observedAt: iso(row.observedAt),
    updatedAt: iso(row.updatedAt),
  };
}

function mapMembership(row: MembershipRow): MembershipRecord {
  if (
    typeof row.permissionSnapshot !== "object" ||
    row.permissionSnapshot === null ||
    Array.isArray(row.permissionSnapshot)
  ) {
    return fail(
      "MEMBERSHIP_PERSISTED_STATE_INVALID",
      "Persisted permission snapshot is not an object."
    );
  }
  return {
    contractVersion: MEMBERSHIP_AUTHORITY_CONTRACT_VERSION,
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
    generation: row.generation,
    sourceVersion: row.sourceVersion,
    sourceCursor: row.sourceCursor,
    observedAt: iso(row.observedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
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

function membershipWhere(scope: MembershipScope, canonicalPrincipalId: UUID) {
  return and(
    eq(membershipAuthorityTable.agentId, scope.agentId),
    eq(membershipAuthorityTable.connectorId, scope.connectorId),
    eq(membershipAuthorityTable.connectorAccountId, scope.connectorAccountId),
    eq(membershipAuthorityTable.externalWorldId, scope.externalWorldId),
    eq(membershipAuthorityTable.externalRoomId, scope.externalRoomId),
    eq(membershipAuthorityTable.canonicalPrincipalId, canonicalPrincipalId)
  );
}

function scopeKey(scope: MembershipScope): string {
  return stableJson([
    scope.agentId,
    scope.connectorId,
    scope.connectorAccountId,
    scope.externalWorldId,
    scope.externalRoomId,
  ]);
}

function decisionKey(scope: MembershipScope, canonicalPrincipalId: UUID): string {
  return `${scopeKey(scope)}\n${canonicalPrincipalId}`;
}

function parseReceipt(row: JournalRow): MembershipMutationReceipt {
  const result = row.result as Partial<MembershipMutationReceipt>;
  if (
    result.contractVersion !== MEMBERSHIP_AUTHORITY_CONTRACT_VERSION ||
    (result.operation !== "membership" && result.operation !== "health") ||
    result.committedGeneration !== row.committedGeneration
  ) {
    return fail("MEMBERSHIP_JOURNAL_INVALID", "Persisted membership receipt is invalid.", {
      journalId: row.id,
    });
  }
  return { ...result, idempotentReplay: true } as MembershipMutationReceipt;
}

export class SqlMembershipService extends MembershipService {
  static override readonly serviceType = MembershipService.serviceType;

  private readonly decisionCache = new Map<
    string,
    { generation: number; decision: MembershipAuthorizationDecision }
  >();
  private readonly invalidators = new Set<MembershipAuthorityInvalidator>();

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new SqlMembershipService(runtime);
    if (!service.db) {
      fail(
        "MEMBERSHIP_SQL_ADAPTER_REQUIRED",
        "SQL membership authority requires a Drizzle-backed adapter."
      );
    }
    return service;
  }

  async stop(): Promise<void> {
    this.decisionCache.clear();
    this.invalidators.clear();
  }

  registerInvalidator(invalidator: MembershipAuthorityInvalidator): () => void {
    this.invalidators.add(invalidator);
    return () => this.invalidators.delete(invalidator);
  }

  private get db(): DrizzleDatabase {
    return getDb(this.runtime.adapter);
  }

  private assertScope(scope: MembershipScope): void {
    if (scope.agentId !== this.runtime.agentId) {
      fail("MEMBERSHIP_TENANT_MISMATCH", "Membership request is outside this runtime tenant.", {
        agentId: scope.agentId,
      });
    }
    for (const [field, value] of Object.entries({
      connectorId: scope.connectorId,
      externalWorldId: scope.externalWorldId,
      externalRoomId: scope.externalRoomId,
    })) {
      if (value.trim().length === 0 || value.length > MAX_IDENTIFIER_LENGTH) {
        fail("MEMBERSHIP_COMMAND_INVALID", `Membership ${field} is invalid.`, { field });
      }
    }
  }

  private assertCommand(command: ApplyMembershipCommand | SetMembershipHealthCommand): Date {
    this.assertScope(command);
    if (
      !Number.isSafeInteger(command.expectedGeneration) ||
      command.expectedGeneration < 0 ||
      command.expectedGeneration === Number.MAX_SAFE_INTEGER
    ) {
      fail("MEMBERSHIP_COMMAND_INVALID", "Expected generation must be a nonnegative integer.");
    }
    if (!Number.isSafeInteger(command.sourceVersion) || command.sourceVersion < 0) {
      fail("MEMBERSHIP_COMMAND_INVALID", "Source version must be a nonnegative integer.");
    }
    if (
      command.idempotencyKey.trim().length === 0 ||
      command.idempotencyKey.length > MAX_IDENTIFIER_LENGTH
    ) {
      fail("MEMBERSHIP_COMMAND_INVALID", "Idempotency key is invalid.");
    }
    if (command.sourceCursor && command.sourceCursor.length > MAX_IDENTIFIER_LENGTH) {
      fail("MEMBERSHIP_COMMAND_INVALID", "Source cursor is invalid.");
    }
    const observedAt = new Date(command.observedAt);
    if (!Number.isFinite(observedAt.getTime())) {
      fail("MEMBERSHIP_COMMAND_INVALID", "Observed timestamp is invalid.");
    }
    return observedAt;
  }

  private assertMembershipCommand(command: ApplyMembershipCommand): void {
    if (
      !MEMBERSHIP_STATES.includes(command.state) ||
      !MEMBERSHIP_REASONS.includes(command.reason)
    ) {
      fail("MEMBERSHIP_COMMAND_INVALID", "Membership state or reason is invalid.");
    }
    const activeReason = ACTIVE_REASONS.has(command.reason);
    if ((command.state === "active") !== activeReason) {
      fail(
        "MEMBERSHIP_COMMAND_INVALID",
        "Membership reason is incompatible with the requested state."
      );
    }
    if (
      command.roles.length > MAX_ROLES ||
      new Set(command.roles).size !== command.roles.length ||
      command.roles.some((role) => role.trim().length === 0 || role.length > 256)
    ) {
      fail("MEMBERSHIP_COMMAND_INVALID", "Membership roles are invalid.");
    }
    if (
      typeof command.permissionSnapshot !== "object" ||
      command.permissionSnapshot === null ||
      Array.isArray(command.permissionSnapshot)
    ) {
      fail("MEMBERSHIP_COMMAND_INVALID", "Permission snapshot must be an object.");
    }
  }

  private async assertReferences(
    tx: DrizzleDatabase,
    command: ApplyMembershipCommand | SetMembershipHealthCommand
  ): Promise<void> {
    const [account] = await tx
      .select({ provider: connectorAccountsTable.provider })
      .from(connectorAccountsTable)
      .where(
        and(
          eq(connectorAccountsTable.id, command.connectorAccountId),
          eq(connectorAccountsTable.agentId, command.agentId)
        )
      )
      .limit(1);
    if (!account || account.provider !== command.connectorId) {
      fail(
        "MEMBERSHIP_CONNECTOR_ACCOUNT_MISMATCH",
        "Connector account does not belong to this connector and tenant."
      );
    }
    if (!("canonicalPrincipalId" in command)) return;

    const requiredEntityIds = new Set<UUID>([command.canonicalPrincipalId]);
    if (command.runtime.entityId) requiredEntityIds.add(command.runtime.entityId);
    const entities = await Promise.all(
      [...requiredEntityIds].map((id) =>
        tx
          .select({ id: entityTable.id })
          .from(entityTable)
          .where(and(eq(entityTable.id, id), eq(entityTable.agentId, command.agentId)))
          .limit(1)
      )
    );
    if (entities.some((rows) => rows.length !== 1)) {
      fail(
        "MEMBERSHIP_PRINCIPAL_NOT_FOUND",
        "Membership principal or runtime entity mapping does not exist in this tenant."
      );
    }
    if (command.runtime.roomId) {
      const [room] = await tx
        .select({ id: roomTable.id })
        .from(roomTable)
        .where(
          and(eq(roomTable.id, command.runtime.roomId), eq(roomTable.agentId, command.agentId))
        )
        .limit(1);
      if (!room) fail("MEMBERSHIP_RUNTIME_MAPPING_INVALID", "Runtime room mapping is invalid.");
    }
    if (command.runtime.worldId) {
      const [world] = await tx
        .select({ id: worldTable.id })
        .from(worldTable)
        .where(
          and(eq(worldTable.id, command.runtime.worldId), eq(worldTable.agentId, command.agentId))
        )
        .limit(1);
      if (!world) fail("MEMBERSHIP_RUNTIME_MAPPING_INVALID", "Runtime world mapping is invalid.");
    }
  }

  private async replay(
    tx: DrizzleDatabase,
    command: ApplyMembershipCommand | SetMembershipHealthCommand,
    digest: string
  ): Promise<MembershipMutationReceipt | null> {
    const [journal] = await tx
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
    if (!journal) return null;
    if (journal.requestDigest !== digest) {
      fail(
        "MEMBERSHIP_IDEMPOTENCY_CONFLICT",
        "Membership idempotency key was reused for a different command."
      );
    }
    return parseReceipt(journal);
  }

  private async advanceScope(
    tx: DrizzleDatabase,
    command: ApplyMembershipCommand | SetMembershipHealthCommand,
    observedAt: Date,
    digest: string,
    healthUpdate?: { health: MembershipHealthState; reason: string }
  ): Promise<{ scope: ScopeRow } | { replay: MembershipMutationReceipt }> {
    await tx
      .insert(membershipAuthorityScopeTable)
      .values({
        agentId: command.agentId,
        connectorId: command.connectorId,
        connectorAccountId: command.connectorAccountId,
        externalWorldId: command.externalWorldId,
        externalRoomId: command.externalRoomId,
        observedAt,
      })
      .onConflictDoNothing();

    const [advanced] = await tx
      .update(membershipAuthorityScopeTable)
      .set({
        generation: command.expectedGeneration + 1,
        sourceVersion: command.sourceVersion,
        sourceCursor: command.sourceCursor,
        observedAt,
        updatedAt: new Date(),
        ...(healthUpdate ?? {}),
      })
      .where(
        and(
          scopeWhere(command),
          eq(membershipAuthorityScopeTable.generation, command.expectedGeneration),
          lt(membershipAuthorityScopeTable.sourceVersion, command.sourceVersion)
        )
      )
      .returning();
    if (advanced) return { scope: advanced };

    // A concurrent exact retry can block behind the winner's generation write.
    // Re-read the journal after that wait so idempotency remains exact rather
    // than leaking a generation error to one of two identical callers.
    const concurrentReplay = await this.replay(tx, command, digest);
    if (concurrentReplay) return { replay: concurrentReplay };

    const [current] = await tx
      .select()
      .from(membershipAuthorityScopeTable)
      .where(scopeWhere(command))
      .limit(1);
    if (!current) {
      fail("MEMBERSHIP_SCOPE_WRITE_FAILED", "Membership scope could not be initialized.");
    }
    if (current.generation !== command.expectedGeneration) {
      fail("MEMBERSHIP_GENERATION_MISMATCH", "Membership scope generation changed.", {
        expectedGeneration: command.expectedGeneration,
        actualGeneration: current.generation,
      });
    }
    fail("MEMBERSHIP_SOURCE_VERSION_STALE", "Membership command is out of order.", {
      sourceVersion: command.sourceVersion,
      currentSourceVersion: current.sourceVersion,
    });
  }

  private async recordJournal(
    tx: DrizzleDatabase,
    operation: "membership" | "health",
    command: ApplyMembershipCommand | SetMembershipHealthCommand,
    digest: string,
    receipt: MembershipMutationReceipt
  ): Promise<void> {
    await tx.insert(membershipAuthorityJournalTable).values({
      agentId: command.agentId,
      connectorId: command.connectorId,
      connectorAccountId: command.connectorAccountId,
      externalWorldId: command.externalWorldId,
      externalRoomId: command.externalRoomId,
      operation,
      canonicalPrincipalId: "canonicalPrincipalId" in command ? command.canonicalPrincipalId : null,
      idempotencyKey: command.idempotencyKey,
      requestDigest: digest,
      expectedGeneration: command.expectedGeneration,
      committedGeneration: receipt.committedGeneration,
      sourceVersion: command.sourceVersion,
      sourceCursor: command.sourceCursor,
      result: JSON.parse(JSON.stringify(receipt)) as Record<string, unknown>,
    });
  }

  private invalidateScope(scope: MembershipScope, receipt: MembershipMutationReceipt): void {
    const prefix = `${scopeKey(scope)}\n`;
    for (const key of this.decisionCache.keys()) {
      if (key.startsWith(prefix)) this.decisionCache.delete(key);
    }
    for (const invalidator of this.invalidators) {
      try {
        invalidator(scope, receipt);
      } catch (error) {
        // error-policy:J7 cache-invalidation diagnostics must not fabricate a rollback after commit.
        this.runtime.reportError("membership-authority-invalidator", error, {
          operation: receipt.operation,
          committedGeneration: receipt.committedGeneration,
        });
      }
    }
  }

  private async notify(scope: MembershipScope, receipt: MembershipMutationReceipt): Promise<void> {
    try {
      await this.runtime.emitEvent(EventType.MEMBERSHIP_AUTHORITY_CHANGED, {
        runtime: this.runtime,
        source: "membership-authority",
        scope,
        receipt,
      });
    } catch (error) {
      // error-policy:J7 observer diagnostics must not turn a committed authority change into failure.
      this.runtime.reportError("membership-authority-observer", error, {
        operation: receipt.operation,
        committedGeneration: receipt.committedGeneration,
      });
    }
  }

  async applyMembership(command: ApplyMembershipCommand): Promise<MembershipMutationReceipt> {
    const observedAt = this.assertCommand(command);
    this.assertMembershipCommand(command);
    const digest = commandDigest("membership", command);
    const receipt = await this.db.transaction(async (tx) => {
      const replay = await this.replay(tx, command, digest);
      if (replay) return replay;
      await this.assertReferences(tx, command);
      const advanced = await this.advanceScope(tx, command, observedAt, digest);
      if ("replay" in advanced) return advanced.replay;
      const { scope } = advanced;
      const now = new Date();
      const [row] = await tx
        .insert(membershipAuthorityTable)
        .values({
          agentId: command.agentId,
          connectorId: command.connectorId,
          connectorAccountId: command.connectorAccountId,
          externalWorldId: command.externalWorldId,
          externalRoomId: command.externalRoomId,
          canonicalPrincipalId: command.canonicalPrincipalId,
          state: command.state,
          reason: command.reason,
          roles: [...command.roles],
          permissionSnapshot: command.permissionSnapshot,
          runtimeWorldId: command.runtime.worldId,
          runtimeRoomId: command.runtime.roomId,
          runtimeEntityId: command.runtime.entityId,
          generation: scope.generation,
          sourceVersion: command.sourceVersion,
          sourceCursor: command.sourceCursor,
          observedAt,
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
            state: command.state,
            reason: command.reason,
            roles: [...command.roles],
            permissionSnapshot: command.permissionSnapshot,
            runtimeWorldId: command.runtime.worldId,
            runtimeRoomId: command.runtime.roomId,
            runtimeEntityId: command.runtime.entityId,
            generation: scope.generation,
            sourceVersion: command.sourceVersion,
            sourceCursor: command.sourceCursor,
            observedAt,
            updatedAt: now,
          },
        })
        .returning();
      if (!row) fail("MEMBERSHIP_WRITE_FAILED", "Membership state was not persisted.");
      const result: MembershipMutationReceipt = {
        contractVersion: MEMBERSHIP_AUTHORITY_CONTRACT_VERSION,
        operation: "membership",
        idempotentReplay: false,
        committedGeneration: scope.generation,
        membership: mapMembership(row),
      };
      await this.recordJournal(tx, "membership", command, digest, result);
      return result;
    });
    if (!receipt.idempotentReplay) {
      this.invalidateScope(command, receipt);
      await this.notify(command, receipt);
    }
    return receipt;
  }

  async setScopeHealth(command: SetMembershipHealthCommand): Promise<MembershipMutationReceipt> {
    const observedAt = this.assertCommand(command);
    if (!MEMBERSHIP_HEALTH_STATES.includes(command.health)) {
      fail("MEMBERSHIP_COMMAND_INVALID", "Membership health state is invalid.");
    }
    if (command.reason.trim().length === 0 || command.reason.length > MAX_IDENTIFIER_LENGTH) {
      fail("MEMBERSHIP_COMMAND_INVALID", "Membership health reason is invalid.");
    }
    const digest = commandDigest("health", command);
    const receipt = await this.db.transaction(async (tx) => {
      const replay = await this.replay(tx, command, digest);
      if (replay) return replay;
      await this.assertReferences(tx, command);
      const advanced = await this.advanceScope(tx, command, observedAt, digest, {
        health: command.health,
        reason: command.reason,
      });
      if ("replay" in advanced) return advanced.replay;
      const { scope: row } = advanced;
      const result: MembershipMutationReceipt = {
        contractVersion: MEMBERSHIP_AUTHORITY_CONTRACT_VERSION,
        operation: "health",
        idempotentReplay: false,
        committedGeneration: row.generation,
        health: mapScope(row),
      };
      await this.recordJournal(tx, "health", command, digest, result);
      return result;
    });
    if (!receipt.idempotentReplay) {
      this.invalidateScope(command, receipt);
      await this.notify(command, receipt);
    }
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
      .where(membershipWhere(scope, canonicalPrincipalId))
      .limit(1);
    return row ? mapMembership(row) : null;
  }

  async authorize(
    scope: MembershipScope,
    canonicalPrincipalId: UUID
  ): Promise<MembershipAuthorizationDecision> {
    this.assertScope(scope);
    const health = await this.getScopeHealth(scope);
    if (!health) {
      return {
        decision: "denied",
        reason: "no_scope_evidence",
        generation: null,
        health: null,
      };
    }
    const key = decisionKey(scope, canonicalPrincipalId);
    const cached = this.decisionCache.get(key);
    if (cached?.generation === health.generation) return cached.decision;

    let decision: MembershipAuthorizationDecision;
    if (health.health !== "current") {
      decision = {
        decision: "denied",
        reason: HEALTH_REASON_BY_STATE[health.health],
        generation: health.generation,
        health: health.health,
      };
    } else {
      const membership = await this.getMembership(scope, canonicalPrincipalId);
      decision = membership
        ? membership.state === "active"
          ? {
              decision: "allowed",
              reason: "active_membership",
              generation: health.generation,
              health: "current",
              membership,
            }
          : {
              decision: "denied",
              reason: "membership_revoked",
              generation: health.generation,
              health: health.health,
            }
        : {
            decision: "denied",
            reason: "no_membership",
            generation: health.generation,
            health: health.health,
          };
    }
    this.decisionCache.set(key, { generation: health.generation, decision });
    return decision;
  }
}
