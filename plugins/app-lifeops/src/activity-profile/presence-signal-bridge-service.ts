import {
  type ActionEventPayload,
  EventType,
  type IAgentRuntime,
  type MessagePayload,
  Service,
} from "@elizaos/core";
import { getDeviceId } from "../lifeops/device-identity.js";
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

function readPlatform(payload: MessagePayload): string {
  const messageRecord = isRecord(payload.message) ? payload.message : null;
  const content = isRecord(messageRecord?.content)
    ? messageRecord?.content
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
      EventType.ACTION_STARTED,
      service.actionStartedHandler,
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
      EventType.ACTION_STARTED,
      this.actionStartedHandler,
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
    eventType: EventType.MESSAGE_RECEIVED | EventType.MESSAGE_SENT,
    payload: MessagePayload,
  ): Promise<void> {
    const entityId = readMessageEntityId(payload);
    if (!entityId || entityId === String(this.runtime.agentId)) {
      return;
    }
    const observedAt = readMessageTimestamp(payload);
    const fingerprint = `${eventType}:${entityId}:${observedAt}`;
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
        source: "connector_activity",
        platform: readPlatform(payload),
        state: "active",
        observedAt,
        idleState: null,
        idleTimeSeconds: 0,
        onBattery: null,
        health: null,
        metadata: {
          eventType,
          entityId,
          deviceId: getDeviceId(),
        },
      }),
    );
  }
}
