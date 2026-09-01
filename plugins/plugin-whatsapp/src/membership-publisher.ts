/**
 * Publishes complete Baileys group rosters and validated participant changes
 * into the canonical membership authority. Each personal-account socket
 * generation is fenced independently; Cloud API webhooks never enter this path.
 */
import {
  createUniqueUuid,
  ElizaError,
  getConnectorAccountManager,
  type IAgentRuntime,
  type JsonObject,
  type MembershipMutationReceipt,
  type MembershipScope,
  MembershipService,
  type MembershipSnapshotMember,
  type PrincipalService,
  ServiceType,
  type UUID,
} from "@elizaos/core";
import type { GroupMetadata, GroupParticipant, ParticipantAction } from "@whiskeysockets/baileys";

const CONNECTOR_ID = "whatsapp";
const EVIDENCE_MODE = "ordered_delta" as const;
const AUTHORITY_TTL_MS = 5 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface BaileysParticipantDelta {
  id: string;
  author: string;
  participants: GroupParticipant[];
  action: ParticipantAction;
}

interface ScopeState {
  scope: MembershipScope;
  publisherInstanceId: string;
  publisherGeneration: number;
  generation: number;
  sourceVersion: number;
  sourceCursor: string | null;
}

function participantId(participant: GroupParticipant): string {
  const value = participant.phoneNumber?.trim() || participant.id.trim();
  if (!value) {
    throw new ElizaError("Baileys group participant omitted its identity", {
      code: "WHATSAPP_MEMBERSHIP_PARTICIPANT_INVALID",
    });
  }
  return value.toLowerCase().replace(/:(\d+)(?=@)/, "");
}

function participantRoles(participant: GroupParticipant): string[] {
  if (participant.isSuperAdmin || participant.admin === "superadmin") {
    return ["member", "admin", "superadmin"];
  }
  if (participant.isAdmin || participant.admin === "admin") {
    return ["member", "admin"];
  }
  return ["member"];
}

function permissionSnapshot(metadata: GroupMetadata, participant: GroupParticipant): JsonObject {
  const roles = participantRoles(participant);
  const isAdmin = roles.includes("admin");
  return {
    transport: "baileys",
    participantId: participantId(participant),
    isAdmin,
    isSuperAdmin: roles.includes("superadmin"),
    canSendMessages: metadata.announce !== true || isAdmin,
    canManageParticipants: isAdmin,
    groupAnnouncementOnly: metadata.announce === true,
    groupRestricted: metadata.restrict === true,
  };
}

function groupId(metadata: Pick<GroupMetadata, "id">): string {
  const id = metadata.id.trim();
  if (!id.endsWith("@g.us")) {
    throw new ElizaError("Baileys membership evidence must identify a WhatsApp group", {
      code: "WHATSAPP_MEMBERSHIP_GROUP_INVALID",
      context: { groupId: id },
    });
  }
  return id;
}

function worldIdentity(metadata: GroupMetadata): string {
  const externalWorld = metadata.linkedParent?.trim() || groupId(metadata);
  return `baileys:${externalWorld}`;
}

function receiptGeneration(receipt: MembershipMutationReceipt): number {
  return receipt.committedGeneration;
}

/** Account-local publisher for Baileys-only membership evidence. */
export class WhatsAppMembershipPublisher {
  private readonly knownGroups = new Map<string, GroupMetadata>();
  private readonly states = new Map<string, ScopeState>();
  private readonly appliedDeltaFingerprints = new Set<string>();
  private accountUuidPromise: Promise<UUID> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private sourceOpen = false;
  private terminated = false;
  private sourceEpoch = 0;
  private publisherInstanceId = "";

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly accountId: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    // error-policy:J5 The returned promise is the observer for the same rejection.
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private authority(): MembershipService {
    const service = this.runtime.getService<MembershipService>(MembershipService.serviceType);
    if (!service) {
      throw new ElizaError("WhatsApp membership publication requires MembershipService", {
        code: "WHATSAPP_MEMBERSHIP_SERVICE_UNAVAILABLE",
        context: { accountId: this.accountId, mode: "baileys" },
      });
    }
    return service;
  }

  private async connectorAccountUuid(): Promise<UUID> {
    if (!this.accountUuidPromise) {
      this.accountUuidPromise = (async () => {
        const manager = getConnectorAccountManager(this.runtime);
        const existing = await manager.getAccount(CONNECTOR_ID, this.accountId);
        if (existing && UUID_PATTERN.test(existing.id)) {
          return existing.id as UUID;
        }
        const persisted = await manager.upsertAccount(
          CONNECTOR_ID,
          {
            id: this.accountId,
            provider: CONNECTOR_ID,
            label: existing?.label ?? this.accountId,
            role: existing?.role ?? "AGENT",
            purpose: existing?.purpose ?? ["messaging"],
            accessGate: existing?.accessGate ?? "open",
            status: "connected",
            externalId: existing?.externalId ?? this.accountId,
            displayHandle: existing?.displayHandle,
            createdAt: existing?.createdAt ?? this.now().getTime(),
            updatedAt: this.now().getTime(),
            metadata: {
              ...(existing?.metadata ?? {}),
              membershipEvidenceMode: "baileys",
            },
          },
          this.accountId
        );
        if (!UUID_PATTERN.test(persisted.id)) {
          throw new ElizaError("WhatsApp connector account did not persist with a UUID", {
            code: "WHATSAPP_MEMBERSHIP_ACCOUNT_INVALID",
            context: { accountId: this.accountId, persistedId: persisted.id },
          });
        }
        return persisted.id as UUID;
      })();
    }
    return this.accountUuidPromise;
  }

  private rawPrincipalId(externalParticipantId: string): UUID {
    return createUniqueUuid(
      this.runtime,
      this.accountId === "default"
        ? `whatsapp-entity:${externalParticipantId}`
        : `whatsapp-entity:${this.accountId}:${externalParticipantId}`
    ) as UUID;
  }

  private async snapshotMember(
    metadata: GroupMetadata,
    participant: GroupParticipant
  ): Promise<MembershipSnapshotMember> {
    const externalParticipantId = participantId(participant);
    const rawPrincipalId = this.rawPrincipalId(externalParticipantId);
    const existing = await this.runtime.getEntityById(rawPrincipalId);
    if (!existing) {
      const created = await this.runtime.createEntity({
        id: rawPrincipalId,
        agentId: this.runtime.agentId,
        names: [
          participant.notify?.trim() ||
            participant.name?.trim() ||
            participant.verifiedName?.trim() ||
            externalParticipantId,
        ],
        metadata: {
          source: CONNECTOR_ID,
          accountId: this.accountId,
          externalParticipantId,
        },
      });
      if (!created && !(await this.runtime.getEntityById(rawPrincipalId))) {
        throw new ElizaError("WhatsApp participant entity could not be materialized", {
          code: "WHATSAPP_MEMBERSHIP_PRINCIPAL_CREATE_FAILED",
          context: { accountId: this.accountId, externalParticipantId },
        });
      }
    }

    const principalService = this.runtime.getService<PrincipalService>(ServiceType.PRINCIPAL);
    const canonicalPrincipalId = principalService
      ? (await principalService.resolveForDataAccess(this.runtime.agentId, rawPrincipalId))
          .canonicalPrincipalId
      : rawPrincipalId;
    return {
      canonicalPrincipalId,
      roles: participantRoles(participant),
      permissionSnapshot: permissionSnapshot(metadata, participant),
      runtime: { worldId: null, roomId: null, entityId: rawPrincipalId },
    };
  }

  private async scope(metadata: GroupMetadata): Promise<MembershipScope> {
    return {
      agentId: this.runtime.agentId,
      connectorId: CONNECTOR_ID,
      connectorAccountId: await this.connectorAccountUuid(),
      externalWorldId: worldIdentity(metadata),
      externalRoomId: groupId(metadata),
    };
  }

  private observedAt(): string {
    return this.now().toISOString();
  }

  private validUntil(): string {
    return new Date(this.now().getTime() + AUTHORITY_TTL_MS).toISOString();
  }

  private beginSourceInternal(): void {
    if (this.sourceOpen) return;
    this.sourceOpen = true;
    this.terminated = false;
    this.sourceEpoch += 1;
    this.publisherInstanceId = `whatsapp:baileys:${this.accountId}:${crypto.randomUUID()}`;
    this.states.clear();
    this.appliedDeltaFingerprints.clear();
  }

  beginSource(): Promise<void> {
    return this.enqueue(async () => {
      this.beginSourceInternal();
    });
  }

  private async ensureState(metadata: GroupMetadata): Promise<ScopeState> {
    this.beginSourceInternal();
    const id = groupId(metadata);
    const nextScope = await this.scope(metadata);
    const priorState = this.states.get(id);
    if (
      priorState &&
      priorState.scope.externalWorldId === nextScope.externalWorldId &&
      priorState.scope.connectorAccountId === nextScope.connectorAccountId
    ) {
      return priorState;
    }
    if (priorState) {
      await this.setUnavailable(priorState, "external_world_changed");
    }

    const authority = this.authority();
    const health = await authority.getScopeHealth(nextScope);
    const publisherGeneration = (health?.publisherGeneration ?? -1) + 1;
    const receipt = await authority.registerPublisher({
      ...nextScope,
      expectedGeneration: health?.generation ?? 0,
      idempotencyKey: `${this.publisherInstanceId}:publisher:${id}`,
      observedAt: this.observedAt(),
      publisherInstanceId: this.publisherInstanceId,
      publisherGeneration,
      evidenceMode: EVIDENCE_MODE,
    });
    const state: ScopeState = {
      scope: nextScope,
      publisherInstanceId: this.publisherInstanceId,
      publisherGeneration,
      generation: receiptGeneration(receipt),
      sourceVersion: -1,
      sourceCursor: null,
    };
    this.states.set(id, state);
    return state;
  }

  private nextCursor(state: ScopeState, kind: string): { version: number; cursor: string } {
    const version = state.sourceVersion + 1;
    return {
      version,
      cursor: `${state.publisherInstanceId}:${this.sourceEpoch}:${state.scope.externalRoomId}:${version}:${kind}`,
    };
  }

  private async applyCompleteMetadata(metadata: GroupMetadata): Promise<void> {
    const id = groupId(metadata);
    const participants = new Map<string, GroupParticipant>();
    for (const participant of metadata.participants) {
      participants.set(participantId(participant), participant);
    }
    const members: MembershipSnapshotMember[] = [];
    for (const participant of participants.values()) {
      members.push(await this.snapshotMember(metadata, participant));
    }
    const state = await this.ensureState(metadata);
    const next = this.nextCursor(state, "snapshot");
    const receipt = await this.authority().applyCompleteSnapshot({
      ...state.scope,
      expectedGeneration: state.generation,
      idempotencyKey: next.cursor,
      observedAt: this.observedAt(),
      publisherInstanceId: state.publisherInstanceId,
      publisherGeneration: state.publisherGeneration,
      evidenceMode: EVIDENCE_MODE,
      sourceVersion: next.version,
      previousSourceCursor: state.sourceCursor,
      sourceCursor: next.cursor,
      validUntil: this.validUntil(),
      completeness: "complete",
      members,
    });
    state.generation = receiptGeneration(receipt);
    state.sourceVersion = next.version;
    state.sourceCursor = next.cursor;
    this.knownGroups.set(id, metadata);
  }

  publishCompleteGroup(metadata: GroupMetadata): Promise<void> {
    return this.enqueue(async () => {
      if (this.terminated) return;
      await this.applyCompleteMetadata(metadata);
    });
  }

  publishReconnectSnapshot(groups: readonly GroupMetadata[]): Promise<void> {
    return this.enqueue(async () => {
      if (this.terminated) return;
      this.beginSourceInternal();
      const observed = new Map(groups.map((metadata) => [groupId(metadata), metadata]));
      const previouslyKnown = new Map(this.knownGroups);
      for (const metadata of observed.values()) {
        await this.applyCompleteMetadata(metadata);
      }
      for (const [id, previous] of previouslyKnown) {
        if (!observed.has(id)) {
          await this.applyCompleteMetadata({ ...previous, participants: [], size: 0 });
        }
      }
    });
  }

  private async reportIncomplete(metadata: GroupMetadata, reason: string): Promise<void> {
    const state = await this.ensureState(metadata);
    const receipt = await this.authority().reportIncompleteSnapshot({
      ...state.scope,
      expectedGeneration: state.generation,
      idempotencyKey: `${state.publisherInstanceId}:incomplete:${state.scope.externalRoomId}:${state.generation}:${reason}`,
      observedAt: this.observedAt(),
      publisherInstanceId: state.publisherInstanceId,
      publisherGeneration: state.publisherGeneration,
      evidenceMode: EVIDENCE_MODE,
      completeness: "incomplete",
      reason,
    });
    state.generation = receiptGeneration(receipt);
  }

  reportReconnectFailure(reason: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.terminated) return;
      this.beginSourceInternal();
      for (const metadata of this.knownGroups.values()) {
        await this.reportIncomplete(metadata, reason);
      }
    });
  }

  publishGroupUpdate(
    group: Pick<GroupMetadata, "id">,
    queryCompleteMetadata: () => Promise<GroupMetadata>
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.terminated) return;
      const known = this.knownGroups.get(groupId(group));
      try {
        await this.applyCompleteMetadata(await queryCompleteMetadata());
      } catch (error) {
        if (known) {
          await this.reportIncomplete(known, "group_metadata_query_failed");
        }
        throw error;
      }
    });
  }

  private deltaFingerprint(event: BaileysParticipantDelta, metadata: GroupMetadata): string {
    const participants = metadata.participants
      .map(
        (participant) => `${participantId(participant)}:${participantRoles(participant).join("+")}`
      )
      .sort()
      .join(",");
    return `${this.sourceEpoch}:${groupId(metadata)}:${event.action}:${event.participants
      .map(participantId)
      .sort()
      .join(",")}:${participants}`;
  }

  private actionMatchesCurrent(
    action: ParticipantAction,
    current: GroupParticipant | undefined
  ): boolean {
    if (action === "add") return current !== undefined;
    if (action === "remove") return current === undefined;
    if (action === "promote")
      return current !== undefined && participantRoles(current).includes("admin");
    if (action === "demote")
      return current !== undefined && !participantRoles(current).includes("admin");
    return false;
  }

  private async applyParticipant(
    state: ScopeState,
    metadata: GroupMetadata,
    event: BaileysParticipantDelta,
    participant: GroupParticipant,
    current: GroupParticipant | undefined
  ): Promise<void> {
    const materialized = await this.snapshotMember(metadata, current ?? participant);
    const stateValue = event.action === "remove" ? "revoked" : "active";
    const authorId = event.author
      .trim()
      .toLowerCase()
      .replace(/:(\d+)(?=@)/, "");
    const reason =
      event.action === "remove"
        ? authorId === participantId(participant)
          ? "left"
          : "kicked"
        : event.action === "promote"
          ? "permission_restored"
          : "joined";
    const next = this.nextCursor(state, `delta:${event.action}:${participantId(participant)}`);
    const receipt = await this.authority().applyMembership({
      ...state.scope,
      expectedGeneration: state.generation,
      idempotencyKey: next.cursor,
      observedAt: this.observedAt(),
      publisherInstanceId: state.publisherInstanceId,
      publisherGeneration: state.publisherGeneration,
      evidenceMode: EVIDENCE_MODE,
      sourceVersion: next.version,
      previousSourceCursor: state.sourceCursor,
      sourceCursor: next.cursor,
      validUntil: this.validUntil(),
      canonicalPrincipalId: materialized.canonicalPrincipalId,
      state: stateValue,
      reason,
      roles: stateValue === "active" ? materialized.roles : [],
      permissionSnapshot:
        stateValue === "active" ? materialized.permissionSnapshot : { transport: "baileys" },
      runtime: materialized.runtime,
    });
    state.generation = receiptGeneration(receipt);
    state.sourceVersion = next.version;
    state.sourceCursor = next.cursor;
  }

  publishParticipantDelta(
    event: BaileysParticipantDelta,
    queryCompleteMetadata: () => Promise<GroupMetadata>
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.terminated) return;
      const id = groupId(event);
      const known = this.knownGroups.get(id);
      const establishedState = this.states.get(id);
      if (
        event.action === "remove" &&
        known &&
        establishedState &&
        establishedState.sourceVersion >= 0
      ) {
        const fingerprint = `${this.sourceEpoch}:${id}:remove:${event.participants
          .map(participantId)
          .sort()
          .join(",")}`;
        if (this.appliedDeltaFingerprints.has(fingerprint)) return;
        for (const removed of event.participants) {
          await this.applyParticipant(establishedState, known, event, removed, undefined);
        }
        const removedIds = new Set(event.participants.map(participantId));
        this.knownGroups.set(id, {
          ...known,
          participants: known.participants.filter(
            (participant) => !removedIds.has(participantId(participant))
          ),
          size: Math.max(0, known.participants.length - removedIds.size),
        });
        this.appliedDeltaFingerprints.add(fingerprint);
        return;
      }
      let metadata: GroupMetadata;
      try {
        metadata = await queryCompleteMetadata();
      } catch (error) {
        if (known) {
          await this.reportIncomplete(known, "participant_point_query_failed");
        }
        throw error;
      }
      if (groupId(metadata) !== id) {
        throw new ElizaError("Baileys participant query returned a different group", {
          code: "WHATSAPP_MEMBERSHIP_GROUP_MISMATCH",
          context: { eventGroupId: id, queryGroupId: metadata.id },
        });
      }
      const fingerprint = this.deltaFingerprint(event, metadata);
      if (this.appliedDeltaFingerprints.has(fingerprint)) return;
      const currentById = new Map(
        metadata.participants.map((participant) => [participantId(participant), participant])
      );
      if (
        event.action === "modify" ||
        event.participants.some(
          (participant) =>
            !this.actionMatchesCurrent(event.action, currentById.get(participantId(participant)))
        )
      ) {
        await this.applyCompleteMetadata(metadata);
        this.appliedDeltaFingerprints.add(fingerprint);
        return;
      }
      const state = await this.ensureState(metadata);
      if (state.sourceVersion < 0) {
        await this.applyCompleteMetadata(metadata);
        this.appliedDeltaFingerprints.add(fingerprint);
        return;
      }
      for (const participant of event.participants) {
        await this.applyParticipant(
          state,
          metadata,
          event,
          participant,
          currentById.get(participantId(participant))
        );
      }
      this.knownGroups.set(id, metadata);
      this.appliedDeltaFingerprints.add(fingerprint);
    });
  }

  private async setUnavailable(state: ScopeState, reason: string): Promise<void> {
    const current = await this.authority().getScopeHealth(state.scope);
    if (!current || current.health === "unavailable") {
      if (current) state.generation = current.generation;
      return;
    }
    const receipt = await this.authority().setScopeHealth({
      ...state.scope,
      expectedGeneration: current.generation,
      idempotencyKey: `${state.publisherInstanceId}:unavailable:${state.scope.externalRoomId}:${current.generation}:${reason}`,
      observedAt: this.observedAt(),
      health: "unavailable",
      reason,
    });
    state.generation = receiptGeneration(receipt);
  }

  markDisconnected(reason = "baileys_disconnected"): Promise<void> {
    return this.enqueue(async () => {
      if (this.terminated) return;
      this.sourceOpen = false;
      for (const state of this.states.values()) {
        await this.setUnavailable(state, reason);
      }
    });
  }

  terminate(reason = "baileys_source_terminated"): Promise<void> {
    return this.enqueue(async () => {
      if (this.terminated) return;
      this.sourceOpen = false;
      for (const state of this.states.values()) {
        await this.setUnavailable(state, reason);
      }
      this.terminated = true;
    });
  }
}
