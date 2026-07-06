/**
 * Service that forwards device presence signals into the activity profile.
 * Listens for message/action runtime events and translates them into
 * LifeOps activity signals keyed by device id, so presence observed on one
 * device contributes to the owner's activity/presence profile.
 */
import crypto from "node:crypto";
import {
  type ActionEventPayload,
  EventType,
  type IAgentRuntime,
  type MessagePayload,
  Service,
  type UUID,
  type ViewSwitchedPayload,
} from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { getDeviceId } from "../lifeops/device-identity.js";
import {
  contactEdgeId,
  LIFEOPS_CONTACT_TAG,
} from "../lifeops/relationships/mapping.js";
import {
  createLifeOpsActivitySignal,
  LifeOpsRepository,
} from "../lifeops/repository.js";

const DEDUPE_WINDOW_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readMessageEntityId(payload: MessagePayload): string | null {
  const record = isRecord(payload.message) ? payload.message : null;
  const entityId = record?.entityId;
  return typeof entityId === "string" && entityId.length > 0 ? entityId : null;
}

function readMessageTimestamp(payload: MessagePayload): string {
  const record = isRecord(payload.message) ? payload.message : null;
  const createdAt = record?.createdAt;
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
    return new Date(createdAt).toISOString();
  }
  return new Date().toISOString();
}

function readEventTimestamp(payload: unknown): string {
  const record = isRecord(payload) ? payload : null;
  const metadata = isRecord(record?.metadata) ? record.metadata : null;
  const candidates = [
    record?.observedAt,
    record?.createdAt,
    record?.timestamp,
    metadata?.observedAt,
    metadata?.createdAt,
    metadata?.timestamp,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return new Date(candidate).toISOString();
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function readMessageId(payload: MessagePayload): string {
  const record = isRecord(payload.message) ? payload.message : null;
  const metadata = isRecord(record?.metadata) ? record.metadata : null;
  const candidates = [metadata?.originalId, record?.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return crypto.randomUUID();
}

function readConversationId(payload: MessagePayload): string {
  const payloadRecord = isRecord(payload) ? payload : null;
  const record = isRecord(payload.message) ? payload.message : null;
  const content = isRecord(record?.content) ? record.content : null;
  const candidates = [
    content?.channelId,
    content?.conversationId,
    content?.threadId,
    record?.roomId,
    payloadRecord?.roomId,
    payload.source,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return "unknown-conversation";
}

function readPlatform(payload: MessagePayload): string {
  const messageRecord = isRecord(payload.message) ? payload.message : null;
  const content = isRecord(messageRecord?.content)
    ? messageRecord.content
    : null;
  const candidates = [
    content?.channelType,
    content?.source,
    messageRecord?.source,
    payload.source,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return "runtime_event";
}

function hashTelemetryIdentity(scope: string, value: string): string {
  return `${scope}:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function readMetadataRecord(payload: MessagePayload): Record<string, unknown> {
  const record = isRecord(payload.message) ? payload.message : null;
  return isRecord(record?.metadata) ? record.metadata : {};
}

function readNestedString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : null;
}

function readMessageHandle(payload: MessagePayload): string | null {
  const payloadRecord = isRecord(payload) ? payload : null;
  const record = isRecord(payload.message) ? payload.message : null;
  const content = isRecord(record?.content) ? record.content : {};
  const metadata = readMetadataRecord(payload);
  const sender = metadata.sender ?? metadata.author ?? metadata.user;
  const imessage = metadata.imessage;
  const candidates = [
    content.handle,
    content.username,
    content.senderUsername,
    content.senderName,
    content.to,
    metadata.to,
    metadata.recipient,
    readNestedString(imessage, "chatId"),
    readNestedString(sender, "username"),
    readNestedString(sender, "handle"),
    readNestedString(sender, "id"),
    metadata.senderHandle,
    metadata.username,
    payloadRecord?.handle,
    payloadRecord?.username,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function readExternalMessageId(payload: MessagePayload): string | undefined {
  const record = isRecord(payload.message) ? payload.message : null;
  const metadata = readMetadataRecord(payload);
  const candidates = [metadata.originalId, metadata.externalId, record?.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function readReactionTargetId(payload: unknown): string {
  const record = isRecord(payload) ? payload : {};
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const candidates = [
    record.targetGuid,
    record.targetMessageId,
    record.messageId,
    record.roomId,
    metadata.targetGuid,
    metadata.targetTweetId,
    metadata.messageId,
    metadata.originalId,
    record.source,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "unknown-reaction-target";
}

function readReactionHandle(payload: unknown): string | null {
  const record = isRecord(payload) ? payload : {};
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const user = isRecord(record.user) ? record.user : {};
  const candidates = [
    record.handle,
    record.username,
    metadata.username,
    metadata.handle,
    metadata.userId,
    user.username,
    user.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function readReactionKind(payload: unknown): string | null {
  const record = isRecord(payload) ? payload : {};
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const candidates = [
    record.reactionString,
    record.reactionKind,
    record.emoji,
    metadata.type,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function readTopLevelEntityId(payload: unknown): string | null {
  const record = isRecord(payload) ? payload : {};
  const entityId = record.entityId;
  return typeof entityId === "string" && entityId.length > 0 ? entityId : null;
}

interface RelationshipActivityContact {
  entityId: UUID;
}

interface RelationshipActivityService {
  getContact(entityId: UUID): Promise<RelationshipActivityContact | null>;
  findByHandle?(
    platform: string,
    identifier: string,
  ): Promise<RelationshipActivityContact | null>;
  recordInteraction?(input: {
    contactId: UUID;
    platform: string;
    direction: "inbound" | "outbound";
    summary?: string;
    externalRef?: string;
    occurredAt?: string;
  }): Promise<unknown>;
}

function isRelationshipActivityContact(
  value: unknown,
): value is RelationshipActivityContact {
  return (
    isRecord(value) &&
    typeof value.entityId === "string" &&
    value.entityId.length > 0
  );
}

function getRelationshipActivityService(
  runtime: IAgentRuntime,
): RelationshipActivityService | null {
  const service: unknown = runtime.getService("relationships");
  if (!isRecord(service)) return null;
  const getContact = service.getContact;
  if (typeof getContact !== "function") return null;
  const findByHandle = service.findByHandle;
  const recordInteraction = service.recordInteraction;
  return {
    getContact: async (entityId) => {
      const result = await getContact.call(service, entityId);
      return isRelationshipActivityContact(result) ? result : null;
    },
    ...(typeof findByHandle === "function"
      ? {
          findByHandle: async (platform, identifier) => {
            const result = await findByHandle.call(
              service,
              platform,
              identifier,
            );
            return isRelationshipActivityContact(result) ? result : null;
          },
        }
      : {}),
    ...(typeof recordInteraction === "function"
      ? {
          recordInteraction: async (input) => {
            await recordInteraction.call(service, input);
          },
        }
      : {}),
  };
}

export class PresenceSignalBridgeService extends Service {
  static override readonly serviceType = "presence_signal_bridge";

  override capabilityDescription =
    "Bridges runtime message activity into LifeOps activity signals for wake detection.";

  private readonly recentFingerprints = new Map<string, number>();

  private readonly messageReceivedHandler = async (
    payload: MessagePayload,
  ): Promise<void> => {
    await this.captureActivityFromMessage(EventType.MESSAGE_RECEIVED, payload);
  };

  private readonly messageSentHandler = async (
    payload: MessagePayload,
  ): Promise<void> => {
    await this.captureActivityFromMessage(EventType.MESSAGE_SENT, payload);
  };

  private readonly reactionReceivedHandler = async (
    payload: MessagePayload,
  ): Promise<void> => {
    if (isRecord(payload.message)) {
      await this.captureActivityFromMessage(
        EventType.REACTION_RECEIVED,
        payload,
      );
      return;
    }
    await this.captureActivityFromReactionMetadata(payload);
  };

  private readonly viewSwitchedHandler = async (
    payload: ViewSwitchedPayload,
  ): Promise<void> => {
    await this.captureActivityFromViewSwitch(payload);
  };

  private readonly actionStartedHandler = async (
    payload: ActionEventPayload,
  ): Promise<void> => {
    await this.captureActivityFromAction(payload);
  };

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<PresenceSignalBridgeService> {
    const service = new PresenceSignalBridgeService(runtime);
    runtime.registerEvent(
      EventType.MESSAGE_RECEIVED,
      service.messageReceivedHandler,
    );
    runtime.registerEvent(EventType.MESSAGE_SENT, service.messageSentHandler);
    runtime.registerEvent(
      EventType.REACTION_RECEIVED,
      service.reactionReceivedHandler,
    );
    runtime.registerEvent(EventType.VIEW_SWITCHED, service.viewSwitchedHandler);
    runtime.registerEvent(
      EventType.ACTION_STARTED,
      service.actionStartedHandler,
    );
    runtime.registerEvent(EventType.VIEW_SWITCHED, service.viewSwitchedHandler);
    runtime.registerEvent(
      EventType.REACTION_RECEIVED,
      service.reactionReceivedHandler,
    );
    return service;
  }

  override async stop(): Promise<void> {
    this.runtime.unregisterEvent(
      EventType.MESSAGE_RECEIVED,
      this.messageReceivedHandler,
    );
    this.runtime.unregisterEvent(
      EventType.MESSAGE_SENT,
      this.messageSentHandler,
    );
    this.runtime.unregisterEvent(
      EventType.REACTION_RECEIVED,
      this.reactionReceivedHandler,
    );
    this.runtime.unregisterEvent(
      EventType.VIEW_SWITCHED,
      this.viewSwitchedHandler,
    );
    this.runtime.unregisterEvent(
      EventType.ACTION_STARTED,
      this.actionStartedHandler,
    );
    this.runtime.unregisterEvent(
      EventType.VIEW_SWITCHED,
      this.viewSwitchedHandler,
    );
    this.runtime.unregisterEvent(
      EventType.REACTION_RECEIVED,
      this.reactionReceivedHandler,
    );
  }

  private async captureActivityFromAction(
    payload: ActionEventPayload,
  ): Promise<void> {
    if (payload.content.source !== "client_chat") {
      return;
    }
    const actionName = payload.content.actions?.[0] ?? "unknown";
    const messageId =
      typeof payload.messageId === "string" ? payload.messageId : "unknown";
    const observedAt = new Date().toISOString();
    const fingerprint = `action:${messageId}`;
    const observedMs = Date.parse(observedAt);
    const existing = this.recentFingerprints.get(fingerprint);
    if (
      existing !== undefined &&
      Number.isFinite(observedMs) &&
      observedMs - existing < DEDUPE_WINDOW_MS
    ) {
      return;
    }
    if (Number.isFinite(observedMs)) {
      this.recentFingerprints.set(fingerprint, observedMs);
    }
    const repository = new LifeOpsRepository(this.runtime);
    await repository.createActivitySignal(
      createLifeOpsActivitySignal({
        agentId: String(this.runtime.agentId),
        source: "app_lifecycle",
        platform: "agent_action",
        state: "active",
        observedAt,
        idleState: "active",
        idleTimeSeconds: 0,
        onBattery: null,
        health: null,
        metadata: {
          eventType: "ACTION_STARTED",
          actionName,
          messageId,
          deviceId: getDeviceId(),
        },
      }),
    );
  }

  private async captureActivityFromMessage(
    eventType:
      | EventType.MESSAGE_RECEIVED
      | EventType.MESSAGE_SENT
      | EventType.REACTION_RECEIVED,
    payload: MessagePayload,
  ): Promise<void> {
    const entityId = readMessageEntityId(payload);
    const handle = readMessageHandle(payload);
    const isAgentEntity = entityId === String(this.runtime.agentId);
    if (!entityId && !handle) {
      return;
    }
    if (isAgentEntity && !handle) {
      return;
    }
    if (isAgentEntity && eventType === EventType.REACTION_RECEIVED) {
      return;
    }
    const observedAt = readMessageTimestamp(payload);
    const fingerprintEntity = handle ?? entityId;
    const fingerprint = `${eventType}:${fingerprintEntity}:${observedAt}`;
    const observedMs = Date.parse(observedAt);
    const existing = this.recentFingerprints.get(fingerprint);
    if (
      existing !== undefined &&
      Number.isFinite(observedMs) &&
      observedMs - existing < DEDUPE_WINDOW_MS
    ) {
      return;
    }
    if (Number.isFinite(observedMs)) {
      this.recentFingerprints.set(fingerprint, observedMs);
    }
    const repository = new LifeOpsRepository(this.runtime);
    const platform = readPlatform(payload);
    const direction =
      eventType === EventType.MESSAGE_SENT ? "outbound_by_owner" : "inbound";
    const senderIdentity = entityId ?? handle ?? "unknown-sender";
    await repository.createActivitySignal(
      createLifeOpsActivitySignal({
        agentId: String(this.runtime.agentId),
        source: "connector_activity",
        platform,
        state: "active",
        observedAt,
        idleState: null,
        idleTimeSeconds: 0,
        onBattery: null,
        health: null,
        metadata: {
          eventType,
          entityId: entityId ?? null,
          ...(handle ? { handle } : {}),
          direction,
          externalMessageId: readMessageId(payload),
          senderHash:
            direction === "outbound_by_owner"
              ? "owner"
              : hashTelemetryIdentity("sender", senderIdentity),
          conversationHash: hashTelemetryIdentity(
            "conversation",
            readConversationId(payload),
          ),
          deviceId: getDeviceId(),
        },
      }),
    );
    await this.recordRelationshipRecency({
      eventType,
      entityId: isAgentEntity ? null : (entityId ?? null),
      observedAt,
      platform,
      payload,
      repository,
    });
  }

  private async captureActivityFromReactionMetadata(
    payload: MessagePayload,
  ): Promise<void> {
    const observedAt = readEventTimestamp(payload);
    const observedMs = Date.parse(observedAt);
    const platform = readPlatform(payload);
    const handle = readReactionHandle(payload);
    const entityId = readTopLevelEntityId(payload);
    const targetId = readReactionTargetId(payload);
    const fingerprint = `reaction:${platform}:${handle ?? entityId ?? targetId}`;
    const existing = this.recentFingerprints.get(fingerprint);
    if (
      existing !== undefined &&
      Number.isFinite(observedMs) &&
      observedMs - existing < DEDUPE_WINDOW_MS
    ) {
      return;
    }
    if (Number.isFinite(observedMs)) {
      this.recentFingerprints.set(fingerprint, observedMs);
    }

    const repository = new LifeOpsRepository(this.runtime);
    await repository.createActivitySignal(
      createLifeOpsActivitySignal({
        agentId: String(this.runtime.agentId),
        source: "connector_activity",
        platform,
        state: "active",
        observedAt,
        idleState: null,
        idleTimeSeconds: 0,
        onBattery: null,
        health: null,
        metadata: {
          eventType: EventType.REACTION_RECEIVED,
          entityId,
          ...(handle ? { handle } : {}),
          direction: "inbound",
          targetHash: hashTelemetryIdentity("reaction-target", targetId),
          ...(readReactionKind(payload)
            ? { reactionKind: readReactionKind(payload) }
            : {}),
          deviceId: getDeviceId(),
        },
      }),
    );
    await this.recordRelationshipRecency({
      eventType: EventType.REACTION_RECEIVED,
      entityId,
      observedAt,
      platform,
      payload,
      repository,
    });
  }

  private async captureActivityFromViewSwitch(
    payload: ViewSwitchedPayload,
  ): Promise<void> {
    if (payload.initiatedBy !== "user") {
      return;
    }
    const observedAt = readEventTimestamp(payload);
    const observedMs = Date.parse(observedAt);
    const fingerprint = `view:${payload.viewId}:${payload.roomId ?? ""}`;
    const existing = this.recentFingerprints.get(fingerprint);
    if (
      existing !== undefined &&
      Number.isFinite(observedMs) &&
      observedMs - existing < DEDUPE_WINDOW_MS
    ) {
      return;
    }
    if (Number.isFinite(observedMs)) {
      this.recentFingerprints.set(fingerprint, observedMs);
    }

    const repository = new LifeOpsRepository(this.runtime);
    await repository.createActivitySignal(
      createLifeOpsActivitySignal({
        agentId: String(this.runtime.agentId),
        source: "app_lifecycle",
        platform: "app_view",
        state: "active",
        observedAt,
        idleState: "active",
        idleTimeSeconds: 0,
        onBattery: null,
        health: null,
        metadata: {
          eventType: EventType.VIEW_SWITCHED,
          viewId: payload.viewId,
          ...(payload.viewLabel ? { viewLabel: payload.viewLabel } : {}),
          ...(payload.viewPath ? { viewPath: payload.viewPath } : {}),
          ...(payload.viewType ? { viewType: payload.viewType } : {}),
          ...(payload.previousViewId
            ? { previousViewId: payload.previousViewId }
            : {}),
          ...(payload.roomId ? { roomId: payload.roomId } : {}),
          deviceId: getDeviceId(),
        },
      }),
    );
  }

  private async recordRelationshipRecency(args: {
    eventType:
      | EventType.MESSAGE_RECEIVED
      | EventType.MESSAGE_SENT
      | EventType.REACTION_RECEIVED;
    entityId: string | null;
    observedAt: string;
    platform: string;
    payload: MessagePayload;
    repository: LifeOpsRepository;
  }): Promise<void> {
    const direction =
      args.eventType === EventType.MESSAGE_SENT ? "outbound" : "inbound";
    const handle = readMessageHandle(args.payload);
    const externalRef = readExternalMessageId(args.payload);
    const isReaction = args.eventType === EventType.REACTION_RECEIVED;
    const summary = `Passive ${args.platform} ${isReaction ? "reaction" : "message"} activity`;
    const evidenceKind = isReaction ? "reaction_ingest" : "message_ingest";
    const service = getRelationshipActivityService(this.runtime);

    let contactId: UUID | null = null;
    if (service?.findByHandle && handle) {
      const matched = await service.findByHandle(args.platform, handle);
      contactId = matched?.entityId ?? null;
    }
    if (!contactId && service && args.entityId) {
      const direct = await service.getContact(args.entityId as UUID);
      contactId = direct?.entityId ?? null;
    }
    if (contactId && service?.recordInteraction) {
      await service.recordInteraction({
        contactId,
        platform: args.platform,
        direction,
        summary,
        ...(externalRef ? { externalRef } : {}),
        occurredAt: args.observedAt,
      });
    }

    const agentId = String(this.runtime.agentId);
    const entityStore = await args.repository.entityStore(agentId);
    let graphEntityId = contactId ?? args.entityId;
    if (handle && !contactId) {
      const observed = await entityStore.observeIdentity({
        platform: args.platform,
        handle,
        evidence: [LIFEOPS_CONTACT_TAG, evidenceKind],
        confidence: 0.8,
        suggestedType: "person",
      });
      graphEntityId = observed.entity.entityId;
    }
    if (!graphEntityId) {
      return;
    }
    await entityStore.recordInteraction(graphEntityId, {
      platform: args.platform,
      direction,
      summary,
      occurredAt: args.observedAt,
    });

    const relationshipStore = await args.repository.relationshipStore(agentId);
    const existingEdge = await relationshipStore.get(
      contactEdgeId(graphEntityId),
    );
    if (!existingEdge) {
      return;
    }
    await relationshipStore.observe({
      fromEntityId: SELF_ENTITY_ID,
      toEntityId: graphEntityId,
      type: existingEdge.type,
      metadataPatch: {
        lastInteractionPlatform: args.platform,
        lastInteractionDirection: direction,
      },
      evidence: [LIFEOPS_CONTACT_TAG, evidenceKind],
      confidence: 0.8,
      occurredAt: args.observedAt,
      source: "extraction",
    });
  }
}
