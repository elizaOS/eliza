import {
  ChannelType,
  type Content,
  ContentType,
  createMessageMemory,
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  type JsonValue,
  logger,
  type Memory,
  Service,
  type UUID,
} from "@elizaos/core";
import type {
  GatewayRelayRequest,
  GatewayRelayRequestEnvelope,
  GatewayRelayResponse,
  PollGatewayRelayResponse,
  RegisterGatewayRelaySessionResponse,
} from "../types/cloud";
import type { CloudAuthService } from "./cloud-auth";

const POLL_TIMEOUT_MS = 25_000;
const REQUEST_TIMEOUT_MS = POLL_TIMEOUT_MS + 5_000;
const RETRY_DELAY_MS = 2_000;
const IDLE_DELAY_MS = 250;

type RelayRequestMethod = "GET" | "POST" | "DELETE";
type RelayRuntimeStatus = "idle" | "registered" | "polling" | "error" | "stopped";

interface RelayRequestJsonOptions {
  method: RelayRequestMethod;
  json?: unknown;
  query?: Record<string, string | number | boolean>;
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuidLike(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveChannelType(value: unknown): ChannelType {
  const candidate = asTrimmedString(value)?.toUpperCase();
  return candidate && candidate in ChannelType
    ? ChannelType[candidate as keyof typeof ChannelType]
    : ChannelType.DM;
}

function isCloudProvisionedRuntime(): boolean {
  if (typeof process === "undefined") {
    return false;
  }
  return process.env.ELIZA_CLOUD_PROVISIONED === "1";
}

function isNodeHost(): boolean {
  return typeof process !== "undefined" && typeof process.versions?.node === "string";
}

function normalizeAttachments(value: unknown): Content["attachments"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const attachments = value
    .map((entry, index) => {
      if (!isRecord(entry)) {
        return null;
      }

      const url = asTrimmedString(entry.url);
      if (!url) {
        return null;
      }

      const type = asTrimmedString(entry.type)?.toLowerCase();
      return {
        id: asTrimmedString(entry.id) ?? `${index}:${url}`,
        url,
        source: asTrimmedString(entry.source),
        title: asTrimmedString(entry.title),
        description: asTrimmedString(entry.description),
        text: asTrimmedString(entry.text),
        contentType:
          type === "image"
            ? ContentType.IMAGE
            : type === "video"
              ? ContentType.VIDEO
              : type === "audio"
                ? ContentType.AUDIO
                : type === "document"
                  ? ContentType.DOCUMENT
                  : undefined,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return attachments.length > 0 ? attachments : undefined;
}

function toJsonRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function toJsonMetadataRecord(value: unknown): Record<string, JsonValue> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

type GatewayMessagePayload = {
  text: string;
  roomKey: string;
  channelType: ChannelType;
  source: string;
  senderId: string;
  senderUserName: string;
  senderName: string;
  attachments?: Content["attachments"];
  senderMetadata?: Record<string, unknown>;
  transportMetadata?: Record<string, unknown>;
};

function buildGatewayMessagePayload(
  runtime: IAgentRuntime,
  rpc: GatewayRelayRequest
): GatewayMessagePayload | null {
  const params = toJsonRecord(rpc.params);
  const sender = toJsonRecord(params?.sender);

  const source = asTrimmedString(params?.source) ?? "eliza_cloud_gateway";
  const text = typeof params?.text === "string" ? params.text : "";
  const senderId = asTrimmedString(sender?.id) ?? `${source}:anonymous`;
  const senderUserName = asTrimmedString(sender?.username) ?? senderId;
  const senderName =
    asTrimmedString(sender?.displayName) ?? asTrimmedString(sender?.name) ?? senderUserName;
  const roomKey =
    asTrimmedString(params?.roomId) ??
    `${source}:${senderId}:${String(rpc.id ?? Date.now())}:${runtime.agentId}`;

  if (!text.trim() && !normalizeAttachments(params?.attachments)?.length) {
    return null;
  }

  return {
    text: text.trim() || " ",
    roomKey,
    channelType: resolveChannelType(params?.channelType),
    source,
    senderId,
    senderUserName,
    senderName,
    attachments: normalizeAttachments(params?.attachments),
    senderMetadata: toJsonRecord(sender?.metadata),
    transportMetadata: toJsonRecord(params?.metadata),
  };
}

function buildWorldKey(
  source: string,
  metadata: Record<string, unknown> | undefined,
  roomKey: string
): string {
  const discord = toJsonRecord(metadata?.discord);
  const guildId = asTrimmedString(discord?.guildId);
  if (guildId) {
    return `gateway:${source}:guild:${guildId}`;
  }

  const threadId = asTrimmedString(metadata?.threadId);
  if (threadId) {
    return `gateway:${source}:thread:${threadId}`;
  }

  return `gateway:${source}:room:${roomKey}`;
}

class SessionMissingError extends Error {
  constructor() {
    super("Gateway relay session missing");
    this.name = "SessionMissingError";
  }
}

export class CloudManagedGatewayRelayService extends Service {
  static serviceType = "CLOUD_MANAGED_GATEWAY_RELAY";
  capabilityDescription =
    "Registers a local Eliza runtime with the cloud managed gateway and handles inbound relay traffic";

  private authService: CloudAuthService | null = null;
  private loopPromise: Promise<void> | null = null;
  private currentSessionId: string | null = null;
  private stopping = false;
  private activeAbortController: AbortController | null = null;
  private relayStatus: RelayRuntimeStatus = "idle";
  private lastSeenAt: string | null = null;

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CloudManagedGatewayRelayService(runtime);
    await service.initialize();
    return service;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.relayStatus = "stopped";
    this.activeAbortController?.abort();

    if (this.loopPromise) {
      await this.loopPromise.catch((error) => {
        logger.debug(
          `[CloudManagedGatewayRelay] Ignoring relay loop shutdown error: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }

    const sessionId = this.currentSessionId;
    this.currentSessionId = null;
    if (sessionId) {
      await this.disconnectSession(sessionId);
    }
  }

  private async initialize(): Promise<void> {
    if (!isNodeHost()) {
      logger.debug("[CloudManagedGatewayRelay] Skipping gateway relay outside Node.js runtime");
      this.relayStatus = "stopped";
      return;
    }

    if (isCloudProvisionedRuntime()) {
      logger.debug(
        "[CloudManagedGatewayRelay] Skipping local relay inside provisioned cloud runtime"
      );
      this.relayStatus = "stopped";
      return;
    }

    if (!this.runtime.messageService) {
      logger.debug("[CloudManagedGatewayRelay] Skipping gateway relay without message service");
      this.relayStatus = "idle";
      return;
    }

    const auth = this.runtime.getService("CLOUD_AUTH");
    if (!auth) {
      logger.debug("[CloudManagedGatewayRelay] CloudAuthService not available");
      this.relayStatus = "idle";
      return;
    }

    this.authService = auth as CloudAuthService;
    if (!this.authService.isAuthenticated()) {
      logger.debug(
        "[CloudManagedGatewayRelay] Skipping gateway relay while cloud auth is inactive"
      );
      this.relayStatus = "idle";
      return;
    }

    this.startRelayLoopIfReady();
  }

  getSessionInfo(): {
    sessionId: string | null;
    organizationId: string | null;
    userId: string | null;
    agentName: string | null;
    platform: string | null;
    lastSeenAt: string | null;
    status: RelayRuntimeStatus;
  } {
    const auth = this.authService;
    const status =
      this.stopping || this.relayStatus === "stopped"
        ? "stopped"
        : auth?.isAuthenticated() === false
          ? "idle"
          : this.relayStatus;

    return {
      sessionId: this.currentSessionId,
      organizationId: auth?.getOrganizationId() ?? null,
      userId: auth?.getUserId() ?? null,
      agentName: this.getAgentName(),
      platform: "local-runtime",
      lastSeenAt: this.lastSeenAt,
      status,
    };
  }

  startRelayLoopIfReady(): boolean {
    if (this.loopPromise && !this.stopping) {
      return true;
    }

    const auth =
      this.authService ?? (this.runtime.getService("CLOUD_AUTH") as CloudAuthService | null);
    if (!auth?.isAuthenticated() || !this.runtime.messageService) {
      this.relayStatus = "idle";
      return false;
    }

    this.authService = auth;
    this.stopping = false;
    this.relayStatus = "idle";
    this.loopPromise = this.runLoop();
    logger.info("[CloudManagedGatewayRelay] Local gateway relay loop started");
    return true;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (!this.currentSessionId) {
          this.currentSessionId = await this.registerSession();
          this.relayStatus = "registered";
          this.lastSeenAt = new Date().toISOString();
          continue;
        }

        this.relayStatus = "polling";
        const request = await this.pollNextRequest(this.currentSessionId);
        this.lastSeenAt = new Date().toISOString();
        if (!request) {
          this.relayStatus = "registered";
          await sleep(IDLE_DELAY_MS);
          continue;
        }

        const response = await this.handleRequest(request.rpc);
        await this.submitResponse(this.currentSessionId, request.requestId, response);
        this.relayStatus = "registered";
      } catch (error) {
        if (this.stopping) {
          return;
        }

        if (error instanceof SessionMissingError) {
          this.currentSessionId = null;
          this.relayStatus = "idle";
          await sleep(IDLE_DELAY_MS);
          continue;
        }

        this.relayStatus = "error";
        logger.warn(
          `[CloudManagedGatewayRelay] Relay loop error: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  private getAgentName(): string {
    return this.runtime.character?.name?.trim() || "Eliza";
  }

  private getClient() {
    const client = this.authService?.getClient();
    if (!client) {
      throw new Error("Cloud API client is unavailable");
    }
    return client;
  }

  private async requestJson<T>(
    path: string,
    options: RelayRequestJsonOptions
  ): Promise<{ status: number; body: T }> {
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    this.activeAbortController = controller;

    try {
      const response = await this.getClient().requestRaw(options.method, path, {
        headers: {
          Accept: "application/json",
        },
        json: options.json,
        query: options.query,
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => ({}))) as T;
      return { status: response.status, body };
    } finally {
      clearTimeout(timeoutId);
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
    }
  }

  private async registerSession(): Promise<string> {
    const { status, body } = await this.requestJson<RegisterGatewayRelaySessionResponse>(
      "/eliza/gateway-relay/sessions",
      {
        method: "POST",
        json: {
          runtimeAgentId: this.runtime.agentId,
          agentName: this.getAgentName(),
        },
      }
    );

    if (status >= 400 || !body?.success || !body.data?.session?.id) {
      throw new Error(`Failed to register gateway relay session (status=${status})`);
    }

    logger.info(
      `[CloudManagedGatewayRelay] Registered local runtime for managed gateway (${body.data.session.id})`
    );
    return body.data.session.id;
  }

  private async disconnectSession(sessionId: string): Promise<void> {
    try {
      await this.requestJson<{ success?: boolean }>(
        `/eliza/gateway-relay/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: "DELETE",
          timeoutMs: 10_000,
        }
      );
    } catch (error) {
      logger.debug(
        `[CloudManagedGatewayRelay] Failed to disconnect relay session ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async pollNextRequest(sessionId: string): Promise<GatewayRelayRequestEnvelope | null> {
    const { status, body } = await this.requestJson<PollGatewayRelayResponse>(
      `/eliza/gateway-relay/sessions/${encodeURIComponent(sessionId)}/next`,
      {
        method: "GET",
        query: { timeoutMs: POLL_TIMEOUT_MS },
        timeoutMs: POLL_TIMEOUT_MS + 5_000,
      }
    );

    if (status === 404) {
      throw new SessionMissingError();
    }

    if (status >= 400 || !body?.success) {
      throw new Error(`Failed to poll gateway relay session ${sessionId} (status=${status})`);
    }

    return body.data?.request ?? null;
  }

  private async submitResponse(
    sessionId: string,
    requestId: string,
    response: GatewayRelayResponse
  ): Promise<void> {
    const { status, body } = await this.requestJson<{ success?: boolean }>(
      `/eliza/gateway-relay/sessions/${encodeURIComponent(sessionId)}/responses`,
      {
        method: "POST",
        json: { requestId, response },
      }
    );

    if (status === 404) {
      throw new SessionMissingError();
    }

    if (status >= 400 || body?.success === false) {
      throw new Error(`Failed to submit gateway relay response (status=${status})`);
    }
  }

  private async handleRequest(rpc: GatewayRelayRequest): Promise<GatewayRelayResponse> {
    switch (rpc.method) {
      case "heartbeat":
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          result: { timestamp: Date.now() },
        };
      case "status.get":
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            status: "running",
            runtimeAgentId: this.runtime.agentId,
            agentName: this.getAgentName(),
          },
        };
      case "message.send":
        return this.handleMessageSend(rpc);
      default:
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: -32601,
            message: `Unsupported relay method: ${rpc.method}`,
          },
        };
    }
  }

  private async handleMessageSend(rpc: GatewayRelayRequest): Promise<GatewayRelayResponse> {
    if (!this.runtime.messageService) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32603, message: "Message service is not available" },
      };
    }

    const payload = buildGatewayMessagePayload(this.runtime, rpc);
    if (!payload) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32602, message: "Invalid message relay payload" },
      };
    }

    const roomId = isUuidLike(payload.roomKey)
      ? payload.roomKey
      : createUniqueUuid(this.runtime, payload.roomKey);
    const worldId = createUniqueUuid(
      this.runtime,
      buildWorldKey(payload.source, payload.transportMetadata, payload.roomKey)
    );
    const entityId = createUniqueUuid(this.runtime, `${payload.source}:${payload.senderId}`);
    const messageServerId = createUniqueUuid(this.runtime, `eliza-cloud-gateway:${payload.source}`);
    const messageId = createUniqueUuid(
      this.runtime,
      `${payload.source}:${payload.roomKey}:${String(rpc.id ?? Date.now())}:inbound`
    );

    const transportMetadata = toJsonMetadataRecord(payload.transportMetadata);

    await this.runtime.ensureConnection({
      entityId,
      roomId,
      roomName: payload.roomKey,
      worldId,
      worldName: payload.source,
      userName: payload.senderUserName,
      name: payload.senderName,
      source: payload.source,
      channelId: payload.roomKey,
      type: payload.channelType,
      messageServerId,
      metadata: transportMetadata,
    });

    const message = createMessageMemory({
      id: messageId,
      entityId,
      agentId: this.runtime.agentId,
      roomId,
      content: {
        text: payload.text,
        source: payload.source,
        channelType: payload.channelType,
        ...(payload.attachments ? { attachments: payload.attachments } : {}),
      },
    });

    message.metadata = {
      ...(message.metadata as Record<string, JsonValue>),
      entityName: payload.senderName,
      entityUserName: payload.senderUserName,
      ...(payload.senderMetadata
        ? { gatewaySender: toJsonMetadataRecord(payload.senderMetadata) }
        : {}),
      ...(payload.transportMetadata ? { gatewayMetadata: transportMetadata } : {}),
    } as typeof message.metadata;

    const callbackTexts: string[] = [];
    const callback: HandlerCallback = async (content: Content) => {
      const responseText = typeof content.text === "string" ? content.text : "";
      if (responseText.trim()) {
        callbackTexts.push(responseText);
      }

      const responseMemory = createMessageMemory({
        id: createUniqueUuid(
          this.runtime,
          `${payload.source}:${payload.roomKey}:${String(
            rpc.id ?? Date.now()
          )}:response:${callbackTexts.length}`
        ),
        entityId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
          ...content,
          text: responseText,
          source: payload.source,
          channelType: payload.channelType,
        },
      });

      await this.runtime.createMemory(responseMemory, "messages");
      return [responseMemory as Memory];
    };

    try {
      const result = await this.runtime.messageService.handleMessage(
        this.runtime,
        message,
        callback
      );
      const replyText =
        callbackTexts[callbackTexts.length - 1] ??
        (typeof result.responseContent?.text === "string"
          ? result.responseContent.text
          : undefined);

      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          didRespond: result.didRespond,
          ...(replyText ? { text: replyText } : {}),
          runtimeAgentId: this.runtime.agentId,
        },
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
