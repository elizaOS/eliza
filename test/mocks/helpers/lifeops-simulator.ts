import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveOAuthDir } from "@elizaos/agent/config/paths";
import type {
  AgentRuntime,
  Content,
  Memory,
  TargetInfo,
  UUID,
} from "@elizaos/core";
import { ChannelType, stringToUuid } from "@elizaos/core";
import {
  LIFEOPS_DISCORD_CAPABILITIES,
  LIFEOPS_SIGNAL_CAPABILITIES,
  LIFEOPS_TELEGRAM_CAPABILITIES,
  type LifeOpsSignalInboundMessage,
} from "@elizaos/shared";
import {
  createLifeOpsConnectorGrant,
  LifeOpsRepository,
} from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { LifeOpsService } from "../../../plugins/app-lifeops/src/lifeops/service.ts";
import {
  readSignalInboundMessages,
  readSignalLocalClientConfigFromEnv,
} from "../../../plugins/app-lifeops/src/lifeops/signal-local-client.ts";
import { buildTelegramTokenRef } from "../../../plugins/app-lifeops/src/lifeops/telegram-auth.ts";
import { TELEGRAM_LOCAL_MOCK_SESSION_PREFIX } from "../../../plugins/app-lifeops/src/lifeops/telegram-local-client.ts";
import {
  assertLifeOpsSimulatorFixtureIntegrity,
  getLifeOpsSimulatorPerson,
  LIFEOPS_SIMULATOR_CHANNEL_MESSAGES,
  LIFEOPS_SIMULATOR_OWNER,
  LIFEOPS_SIMULATOR_OWNER_IDENTITIES,
  LIFEOPS_SIMULATOR_PEOPLE,
  LIFEOPS_SIMULATOR_REMINDERS,
  type LifeOpsSimulatorChannelMessage,
  lifeOpsSimulatorMessageTime,
  lifeOpsSimulatorSummary,
} from "../fixtures/lifeops-simulator.ts";
import { ensureLifeOpsSchema } from "./seed-grants.ts";

type Cleanup = () => Promise<void> | void;
type RuntimeSendHandler = Parameters<AgentRuntime["registerSendHandler"]>[1];

interface SignalRecentMessage {
  id: string;
  roomId: string;
  channelId: string;
  roomName: string;
  speakerName: string;
  text: string;
  createdAt: number;
  isFromAgent: boolean;
  isGroup: boolean;
}

interface SignalMockService {
  getAccountNumber(): string;
  isServiceConnected(): boolean;
  getRecentMessages(limit?: number): Promise<SignalRecentMessage[]>;
  sendMessage(recipient: string, text: string): Promise<{ timestamp: number }>;
  stop(): Promise<void>;
}

interface WhatsAppMockService {
  connected: boolean;
  phoneNumber: string;
  handleWebhook(payload: Record<string, unknown>): Promise<void>;
  fetchConnectorMessages(limit?: number): Promise<Memory[]>;
}

interface BrowserWorkspaceTab {
  id: string;
  url?: string;
  partition?: string;
}

export interface LifeOpsSimulatorRuntimeFixtures {
  applyRuntimeFixtures(runtime: AgentRuntime): Promise<Cleanup>;
}

export interface LifeOpsSimulatorSeedResult {
  summary: ReturnType<typeof lifeOpsSimulatorSummary>;
  relationships: number;
  chatMemories: number;
  passiveChatMemoryIds: UUID[];
  reminders: number;
  whatsappBuffered: number;
  telegramTokenRef: string;
  signalTokenRef: string;
}

const LIFEOPS_SIMULATOR_PASSIVE_INGEST = {
  ingestMode: "passive",
  handledByAgent: false,
} as const;

function stateDirFromEnv(): string {
  const dir = process.env.ELIZA_STATE_DIR?.trim();
  if (!dir) {
    throw new Error("LifeOps simulator requires ELIZA_STATE_DIR.");
  }
  return dir;
}

function servicesMap(runtime: AgentRuntime): Map<string, unknown[]> {
  const services: unknown = Reflect.get(runtime, "services");
  if (!(services instanceof Map)) {
    throw new Error(
      "LifeOps simulator requires runtime service registry access.",
    );
  }
  return services;
}

function registeredSendHandlers(
  runtime: AgentRuntime,
): Map<string, RuntimeSendHandler> | null {
  const sendHandlers: unknown = Reflect.get(runtime, "sendHandlers");
  return sendHandlers instanceof Map ? sendHandlers : null;
}

function signalInboundToRecentMessage(
  message: LifeOpsSignalInboundMessage,
): SignalRecentMessage {
  return {
    id: message.id,
    roomId: message.roomId,
    channelId: message.channelId,
    roomName: message.roomName,
    speakerName: message.speakerName,
    text: message.text,
    createdAt: message.createdAt,
    isFromAgent: !message.isInbound,
    isGroup: message.isGroup,
  };
}

function installSignalMockService(runtime: AgentRuntime): Cleanup {
  const services = servicesMap(runtime);
  const previous = services.get("signal");
  const signalService: SignalMockService = {
    getAccountNumber: () => LIFEOPS_SIMULATOR_OWNER.phone,
    isServiceConnected: () => true,
    async getRecentMessages(limit?: number) {
      const config = readSignalLocalClientConfigFromEnv();
      if (!config) {
        return [];
      }
      const messages = await readSignalInboundMessages(config, limit);
      return messages.map(signalInboundToRecentMessage);
    },
    async sendMessage(recipient: string, text: string) {
      const baseUrl = process.env.SIGNAL_HTTP_URL?.replace(/\/$/, "");
      if (!baseUrl) {
        throw new Error(
          "SIGNAL_HTTP_URL is required for simulator Signal send.",
        );
      }
      const response = await fetch(`${baseUrl}/v2/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          number: LIFEOPS_SIMULATOR_OWNER.phone,
          recipients: [recipient],
          message: text,
        }),
      });
      if (!response.ok) {
        throw new Error(
          `Simulator Signal send failed with HTTP ${response.status}`,
        );
      }
      const body = (await response.json()) as { timestamp?: unknown };
      if (typeof body.timestamp !== "number") {
        throw new Error("Simulator Signal send response is missing timestamp.");
      }
      return { timestamp: body.timestamp };
    },
    async stop() {},
  };
  services.set("signal", [signalService]);
  return () => {
    if (previous) {
      services.set("signal", previous);
    } else {
      services.delete("signal");
    }
  };
}

function installWhatsAppMockService(runtime: AgentRuntime): Cleanup {
  const services = servicesMap(runtime);
  const previous = services.get("whatsapp");
  const buffered: Record<string, unknown>[] = [];
  const whatsappService: WhatsAppMockService = {
    connected: true,
    phoneNumber: LIFEOPS_SIMULATOR_OWNER.phone,
    async handleWebhook(payload) {
      buffered.push(payload);
    },
    async fetchConnectorMessages(limit = 25) {
      return [];
    },
  };
  services.set("whatsapp", [whatsappService]);
  return () => {
    buffered.length = 0;
    if (previous) {
      services.set("whatsapp", previous);
    } else {
      services.delete("whatsapp");
    }
  };
}

function browserWorkspaceBaseUrl(): string {
  const baseUrl = process.env.ELIZA_BROWSER_WORKSPACE_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      "ELIZA_BROWSER_WORKSPACE_URL is required for simulator Discord send.",
    );
  }
  return baseUrl.replace(/\/$/, "");
}

function browserWorkspaceToken(): string {
  const token = process.env.ELIZA_BROWSER_WORKSPACE_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "ELIZA_BROWSER_WORKSPACE_TOKEN is required for simulator Discord send.",
    );
  }
  return token;
}

async function browserWorkspaceJson<T>(
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${browserWorkspaceBaseUrl()}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${browserWorkspaceToken()}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Simulator Discord browser workspace call failed with HTTP ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

async function findDiscordWorkspaceTabId(
  runtime: AgentRuntime,
): Promise<string> {
  const body = await browserWorkspaceJson<{ tabs?: BrowserWorkspaceTab[] }>(
    "/tabs",
  );
  const tabs = Array.isArray(body.tabs) ? body.tabs : [];
  const ownerPartition = `lifeops-discord-${runtime.agentId}-owner`;
  function isDiscordUrl(url: unknown): boolean {
    if (typeof url !== "string") return false;
    try {
      const { hostname } = new URL(url);
      return hostname === "discord.com" || hostname.endsWith(".discord.com");
    } catch {
      return false;
    }
  }

  const tab =
    tabs.find(
      (candidate) =>
        candidate.partition === ownerPartition && isDiscordUrl(candidate.url),
    ) ?? tabs.find((candidate) => isDiscordUrl(candidate.url));
  if (!tab) {
    throw new Error("Simulator Discord send requires an open Discord tab.");
  }
  return tab.id;
}

function installDiscordMockSendTarget(runtime: AgentRuntime): Cleanup {
  const handlers = registeredSendHandlers(runtime);
  const hadPrevious = handlers?.has("discord") ?? false;
  const previous = handlers?.get("discord");

  const handler: RuntimeSendHandler = async (
    _runtime,
    target: TargetInfo,
    content: Content,
  ): Promise<void> => {
    const channelId = String(target.channelId ?? "").trim();
    if (!channelId) {
      throw new Error("Simulator Discord send target is missing channelId.");
    }
    const text = typeof content.text === "string" ? content.text.trim() : "";
    if (!text) {
      return;
    }

    const tabId = await findDiscordWorkspaceTabId(runtime);
    const payload = { channelId, text, source: content.source ?? "lifeops" };
    await browserWorkspaceJson(`/tabs/${encodeURIComponent(tabId)}/eval`, {
      method: "POST",
      body: JSON.stringify({
        script: `(() => {
          window.__lifeopsDiscordMockSend = ${JSON.stringify(payload)};
          return { ok: true };
        })();`,
      }),
    });
  };
  runtime.registerSendHandler("discord", handler);

  return () => {
    const currentHandlers = registeredSendHandlers(runtime);
    if (!currentHandlers) {
      return;
    }
    if (hadPrevious && previous) {
      currentHandlers.set("discord", previous);
    } else {
      currentHandlers.delete("discord");
    }
  };
}

export function createLifeOpsSimulatorRuntimeFixtures(): LifeOpsSimulatorRuntimeFixtures {
  return {
    async applyRuntimeFixtures(runtime) {
      const cleanupSignal = installSignalMockService(runtime);
      const cleanupWhatsApp = installWhatsAppMockService(runtime);
      let cleanupDiscord: Cleanup;
      try {
        cleanupDiscord = installDiscordMockSendTarget(runtime);
      } catch (err) {
        await cleanupWhatsApp();
        await cleanupSignal();
        throw err;
      }
      return async () => {
        await cleanupDiscord();
        await cleanupWhatsApp();
        await cleanupSignal();
      };
    },
  };
}

function simulatorRoomId(message: LifeOpsSimulatorChannelMessage): UUID {
  return stringToUuid(`lifeops-sim:${message.channel}:${message.threadId}`);
}

function simulatorWorldId(channel: string): UUID {
  return stringToUuid(`lifeops-sim:${channel}:world`);
}

function simulatorEntityId(personKey: string, channel: string): UUID {
  return stringToUuid(`lifeops-sim:${channel}:${personKey}`);
}

async function seedChatMemory(
  runtime: AgentRuntime,
  message: LifeOpsSimulatorChannelMessage,
): Promise<UUID> {
  const person = getLifeOpsSimulatorPerson(message.fromPersonKey);
  const roomId = simulatorRoomId(message);
  const entityId = simulatorEntityId(message.fromPersonKey, message.channel);
  const worldId = simulatorWorldId(message.channel);

  await runtime.ensureWorldExists({
    id: worldId,
    name: `${message.channel}-lifeops-simulator`,
    agentId: runtime.agentId,
  } as Parameters<typeof runtime.ensureWorldExists>[0]);

  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    userName: person.name,
    name: person.name,
    source: message.channel,
    channelId: message.threadId,
    type: message.threadType === "group" ? ChannelType.GROUP : ChannelType.DM,
  });
  await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
  await runtime.ensureParticipantInRoom(entityId, roomId);
  await runtime.updateParticipantUserState(roomId, runtime.agentId, "MUTED");

  const memoryId = stringToUuid(`lifeops-sim:message:${message.id}`);
  const memory: Memory = {
    id: memoryId,
    agentId: runtime.agentId,
    roomId,
    entityId,
    content: {
      text: message.text,
      source: message.channel,
      name: person.name,
      channelType:
        message.threadType === "group" ? ChannelType.GROUP : ChannelType.DM,
      simulator: {
        id: message.id,
        ...LIFEOPS_SIMULATOR_PASSIVE_INGEST,
        threadId: message.threadId,
        threadName: message.threadName,
        unread: message.unread === true,
      },
    },
    metadata: {
      entityName: person.name,
      simulator: {
        id: message.id,
        ...LIFEOPS_SIMULATOR_PASSIVE_INGEST,
        channel: message.channel,
      },
    },
    createdAt: Date.parse(lifeOpsSimulatorMessageTime(message.sentAtOffsetMs)),
  } as Memory;
  await runtime.createMemory(memory, "messages");
  return memoryId;
}

function writeTelegramMockSession(stateDir: string): void {
  const telegramSessionDir = path.join(stateDir, "telegram-account");
  fs.mkdirSync(telegramSessionDir, { recursive: true, mode: 0o700 });
  const dialogs = LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.filter(
    (message) => message.channel === "telegram",
  ).map((message) => {
    const person = getLifeOpsSimulatorPerson(message.fromPersonKey);
    return {
      id: message.threadId,
      title: message.threadName,
      username:
        message.threadType === "dm" ? person.telegramUsername : undefined,
      unreadCount: message.unread ? 1 : 0,
      readOutboxMaxId: 10,
      messages: [
        {
          id: Number.parseInt(person.telegramPeerId, 10),
          message: message.text,
          date: lifeOpsSimulatorMessageTime(message.sentAtOffsetMs),
          out: message.outgoing === true,
          fromId: person.telegramPeerId,
        },
      ],
    };
  });
  const encoded = Buffer.from(JSON.stringify({ dialogs }), "utf8").toString(
    "base64url",
  );
  fs.writeFileSync(
    path.join(telegramSessionDir, "session.txt"),
    `${TELEGRAM_LOCAL_MOCK_SESSION_PREFIX}${encoded}`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function writeTelegramToken(runtime: AgentRuntime): string {
  const telegramIdentity = LIFEOPS_SIMULATOR_OWNER_IDENTITIES.telegram;
  const tokenRef = buildTelegramTokenRef(runtime.agentId, "owner");
  const tokenPath = path.join(
    resolveOAuthDir(process.env),
    "lifeops",
    "telegram",
    tokenRef,
  );
  const now = new Date().toISOString();
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    tokenPath,
    JSON.stringify(
      {
        provider: "telegram",
        agentId: runtime.agentId,
        side: "owner",
        sessionString: "mocked",
        apiId: 1,
        apiHash: "mock-telegram-api-hash",
        phone: LIFEOPS_SIMULATOR_OWNER.phone,
        identity: {
          id: telegramIdentity.id,
          username: telegramIdentity.username,
          firstName: telegramIdentity.firstName,
        },
        connectorConfig: null,
        createdAt: now,
        updatedAt: now,
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
  return tokenRef;
}

function writeSignalDevice(runtime: AgentRuntime): string {
  const signalIdentity = LIFEOPS_SIMULATOR_OWNER_IDENTITIES.signal;
  const authDir = path.join(
    resolveOAuthDir(process.env),
    "lifeops",
    "signal",
    runtime.agentId,
    "owner",
  );
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(authDir, "device-info.json"),
    JSON.stringify(
      {
        authDir,
        phoneNumber: LIFEOPS_SIMULATOR_OWNER.phone,
        uuid: signalIdentity.uuid,
        deviceName: signalIdentity.deviceName,
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
  return authDir;
}

async function seedConnectorGrants(
  runtime: AgentRuntime,
  repository: LifeOpsRepository,
): Promise<{ telegramTokenRef: string; signalTokenRef: string }> {
  const now = new Date().toISOString();
  const ownerIdentities = LIFEOPS_SIMULATOR_OWNER_IDENTITIES;
  const telegramTokenRef = writeTelegramToken(runtime);
  const signalTokenRef = writeSignalDevice(runtime);
  await repository.upsertConnectorGrant(
    createLifeOpsConnectorGrant({
      agentId: runtime.agentId,
      provider: "telegram",
      side: "owner",
      mode: "local",
      identity: {
        phone: LIFEOPS_SIMULATOR_OWNER.phone,
        id: ownerIdentities.telegram.id,
        username: ownerIdentities.telegram.username,
      },
      grantedScopes: [],
      capabilities: [...LIFEOPS_TELEGRAM_CAPABILITIES],
      tokenRef: telegramTokenRef,
      metadata: { mocked: true, simulator: "lifeops" },
      lastRefreshAt: now,
    }),
  );
  await repository.upsertConnectorGrant(
    createLifeOpsConnectorGrant({
      agentId: runtime.agentId,
      provider: "signal",
      side: "owner",
      mode: "local",
      identity: {
        phoneNumber: LIFEOPS_SIMULATOR_OWNER.phone,
        uuid: ownerIdentities.signal.uuid,
      },
      grantedScopes: [],
      capabilities: [...LIFEOPS_SIGNAL_CAPABILITIES],
      tokenRef: signalTokenRef,
      metadata: { mocked: true, simulator: "lifeops" },
      lastRefreshAt: now,
    }),
  );
  await repository.upsertConnectorGrant(
    createLifeOpsConnectorGrant({
      agentId: runtime.agentId,
      provider: "discord",
      side: "owner",
      mode: "local",
      identity: {
        username: ownerIdentities.discord.username,
        id: ownerIdentities.discord.id,
      },
      grantedScopes: [],
      capabilities: [...LIFEOPS_DISCORD_CAPABILITIES],
      tokenRef: null,
      metadata: { mocked: true, simulator: "lifeops" },
      lastRefreshAt: now,
    }),
  );
  return { telegramTokenRef, signalTokenRef };
}

async function seedRelationships(service: LifeOpsService): Promise<number> {
  for (const person of LIFEOPS_SIMULATOR_PEOPLE) {
    await service.upsertRelationship({
      name: person.name,
      primaryChannel: "email",
      primaryHandle: person.email,
      email: person.email,
      phone: person.phone,
      notes: `LifeOps simulator contact; also present on Telegram @${person.telegramUsername}, Discord ${person.discordUsername}, Signal ${person.signalNumber}, WhatsApp ${person.whatsappNumber}.`,
      tags: ["lifeops-simulator", "mock-contact"],
      relationshipType: "contact",
      lastContactedAt: new Date(
        Date.now() - 2 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      metadata: { mocked: true, simulator: "lifeops", personKey: person.key },
    });
  }
  return LIFEOPS_SIMULATOR_PEOPLE.length;
}

async function seedReminders(service: LifeOpsService): Promise<number> {
  for (const reminder of LIFEOPS_SIMULATOR_REMINDERS) {
    const dueAt = new Date(Date.now() + reminder.dueOffsetMs).toISOString();
    await service.createDefinition({
      kind: "task",
      title: reminder.title,
      description: reminder.description,
      originalIntent: reminder.description,
      timezone: LIFEOPS_SIMULATOR_OWNER.timezone,
      priority: 2,
      cadence: { kind: "once", dueAt },
      reminderPlan: {
        steps: [
          {
            channel: reminder.channel,
            offsetMinutes: 0,
            label: "Due now",
          },
        ],
      },
      source: "seed",
      metadata: { mocked: true, simulator: "lifeops", seedKey: reminder.id },
    });
  }
  return LIFEOPS_SIMULATOR_REMINDERS.length;
}

function whatsappWebhookPayload() {
  const whatsappMessages = LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.filter(
    (message) => message.channel === "whatsapp",
  );
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: LIFEOPS_SIMULATOR_OWNER_IDENTITIES.whatsapp.businessAccountId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: LIFEOPS_SIMULATOR_OWNER.phone,
                phone_number_id:
                  LIFEOPS_SIMULATOR_OWNER_IDENTITIES.whatsapp.phoneNumberId,
              },
              contacts: whatsappMessages.map((message) => {
                const person = getLifeOpsSimulatorPerson(message.fromPersonKey);
                return {
                  profile: { name: person.name },
                  wa_id: person.whatsappNumber.replace(/^\+/, ""),
                };
              }),
              messages: whatsappMessages.map((message) => {
                const person = getLifeOpsSimulatorPerson(message.fromPersonKey);
                return {
                  id: message.id,
                  from: person.whatsappNumber.replace(/^\+/, ""),
                  timestamp: String(
                    Math.floor(
                      Date.parse(
                        lifeOpsSimulatorMessageTime(message.sentAtOffsetMs),
                      ) / 1000,
                    ),
                  ),
                  type: "text",
                  text: { body: message.text },
                };
              }),
            },
          },
        ],
      },
    ],
  };
}

export async function seedLifeOpsSimulatorRuntime(
  runtime: AgentRuntime,
): Promise<LifeOpsSimulatorSeedResult> {
  assertLifeOpsSimulatorFixtureIntegrity();
  await ensureLifeOpsSchema(runtime);
  const stateDir = stateDirFromEnv();
  writeTelegramMockSession(stateDir);

  const repository = new LifeOpsRepository(runtime);
  const service = new LifeOpsService(runtime);
  const { telegramTokenRef, signalTokenRef } = await seedConnectorGrants(
    runtime,
    repository,
  );
  await service.authorizeDiscordConnector("owner", "desktop_browser");
  const relationships = await seedRelationships(service);
  const reminders = await seedReminders(service);
  const passiveChatMemoryIds: UUID[] = [];
  for (const message of LIFEOPS_SIMULATOR_CHANNEL_MESSAGES) {
    passiveChatMemoryIds.push(await seedChatMemory(runtime, message));
  }
  const whatsapp = await service.ingestWhatsAppWebhook(
    whatsappWebhookPayload(),
  );

  return {
    summary: lifeOpsSimulatorSummary(),
    relationships,
    chatMemories: LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.length,
    passiveChatMemoryIds,
    reminders,
    whatsappBuffered: whatsapp.ingested,
    telegramTokenRef,
    signalTokenRef,
  };
}

export function lifeOpsSimulatorRunId(): string {
  return `lifeops-simulator-${crypto.randomUUID()}`;
}
