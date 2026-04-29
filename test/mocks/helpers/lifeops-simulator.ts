import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveOAuthDir } from "@elizaos/agent/config/paths";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { ChannelType, stringToUuid } from "@elizaos/core";
import {
  LIFEOPS_DISCORD_CAPABILITIES,
  LIFEOPS_SIGNAL_CAPABILITIES,
  LIFEOPS_TELEGRAM_CAPABILITIES,
} from "@elizaos/shared";
import { TELEGRAM_LOCAL_MOCK_SESSION_PREFIX } from "../../../apps/app-lifeops/src/lifeops/telegram-local-client.ts";
import { buildTelegramTokenRef } from "../../../apps/app-lifeops/src/lifeops/telegram-auth.ts";
import {
  createLifeOpsConnectorGrant,
  LifeOpsRepository,
} from "../../../apps/app-lifeops/src/lifeops/repository.ts";
import { LifeOpsService } from "../../../apps/app-lifeops/src/lifeops/service.ts";
import {
  getLifeOpsSimulatorPerson,
  LIFEOPS_SIMULATOR_CHANNEL_MESSAGES,
  LIFEOPS_SIMULATOR_OWNER,
  LIFEOPS_SIMULATOR_PEOPLE,
  LIFEOPS_SIMULATOR_REMINDERS,
  lifeOpsSimulatorMessageTime,
  lifeOpsSimulatorSummary,
  type LifeOpsSimulatorChannelMessage,
} from "../fixtures/lifeops-simulator.ts";
import { ensureLifeOpsSchema } from "./seed-grants.ts";

type Cleanup = () => Promise<void> | void;

export interface LifeOpsSimulatorRuntimeFixtures {
  applyRuntimeFixtures(runtime: AgentRuntime): Promise<Cleanup>;
}

export interface LifeOpsSimulatorSeedResult {
  summary: ReturnType<typeof lifeOpsSimulatorSummary>;
  relationships: number;
  chatMemories: number;
  reminders: number;
  whatsappBuffered: number;
  telegramTokenRef: string;
  signalTokenRef: string;
}

function stateDirFromEnv(): string {
  const dir =
    process.env.ELIZA_STATE_DIR?.trim() || process.env.MILADY_STATE_DIR?.trim();
  if (!dir) {
    throw new Error(
      "LifeOps simulator requires ELIZA_STATE_DIR or MILADY_STATE_DIR."
    );
  }
  return dir;
}

function servicesMap(runtime: AgentRuntime): Map<string, unknown[]> {
  return (runtime as unknown as { services: Map<string, unknown[]> }).services;
}

function installSignalMockService(runtime: AgentRuntime): Cleanup {
  const services = servicesMap(runtime);
  const previous = services.get("signal");
  const signalService = {
    getAccountNumber: () => LIFEOPS_SIMULATOR_OWNER.phone,
    isServiceConnected: () => true,
    async getRecentMessages() {
      return [];
    },
    async sendMessage(recipient: string, text: string) {
      const baseUrl = process.env.SIGNAL_HTTP_URL?.replace(/\/$/, "");
      if (!baseUrl) {
        throw new Error(
          "SIGNAL_HTTP_URL is required for simulator Signal send."
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
          `Simulator Signal send failed with HTTP ${response.status}`
        );
      }
      const body = (await response.json()) as { timestamp?: number };
      return { timestamp: body.timestamp ?? Date.now() };
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

function installDiscordMockSendTarget(runtime: AgentRuntime): Cleanup {
  const runtimeWithSend = runtime as AgentRuntime & {
    sendMessageToTarget?: (
      target: Record<string, unknown>,
      content: Record<string, unknown>
    ) => Promise<unknown>;
  };
  const previous = runtimeWithSend.sendMessageToTarget;
  runtimeWithSend.sendMessageToTarget = async (target, content) => {
    if (target.source === "discord") {
      return {
        ok: true,
        target,
        content,
      };
    }
    if (typeof previous === "function") {
      return previous.call(runtime, target, content);
    }
    throw new Error("No runtime sendMessageToTarget handler is registered.");
  };
  return () => {
    if (previous) {
      runtimeWithSend.sendMessageToTarget = previous;
    } else {
      delete runtimeWithSend.sendMessageToTarget;
    }
  };
}

export function createLifeOpsSimulatorRuntimeFixtures(): LifeOpsSimulatorRuntimeFixtures {
  return {
    async applyRuntimeFixtures(runtime) {
      const cleanupSignal = installSignalMockService(runtime);
      const cleanupDiscord = installDiscordMockSendTarget(runtime);
      return async () => {
        await cleanupDiscord();
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
  message: LifeOpsSimulatorChannelMessage
): Promise<void> {
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

  const memory: Memory = {
    id: stringToUuid(`lifeops-sim:message:${message.id}`),
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
        threadId: message.threadId,
        threadName: message.threadName,
        unread: message.unread === true,
      },
    },
    createdAt: Date.parse(lifeOpsSimulatorMessageTime(message.sentAtOffsetMs)),
  } as Memory;
  await runtime.createMemory(memory, "messages");
}

function writeTelegramMockSession(stateDir: string): void {
  const telegramSessionDir = path.join(stateDir, "telegram-account");
  fs.mkdirSync(telegramSessionDir, { recursive: true, mode: 0o700 });
  const dialogs = LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.filter(
    (message) => message.channel === "telegram"
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
    "base64url"
  );
  fs.writeFileSync(
    path.join(telegramSessionDir, "session.txt"),
    `${TELEGRAM_LOCAL_MOCK_SESSION_PREFIX}${encoded}`,
    { encoding: "utf8", mode: 0o600 }
  );
}

function writeTelegramToken(runtime: AgentRuntime): string {
  const tokenRef = buildTelegramTokenRef(runtime.agentId, "owner");
  const tokenPath = path.join(
    resolveOAuthDir(process.env),
    "lifeops",
    "telegram",
    tokenRef
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
          id: "lifeops-simulator-owner",
          username: "mocked_lifeops_owner",
          firstName: "Eliza",
        },
        connectorConfig: null,
        createdAt: now,
        updatedAt: now,
      },
      null,
      2
    ),
    { encoding: "utf8", mode: 0o600 }
  );
  return tokenRef;
}

function writeSignalDevice(runtime: AgentRuntime): string {
  const authDir = path.join(
    resolveOAuthDir(process.env),
    "lifeops",
    "signal",
    runtime.agentId,
    "owner"
  );
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(authDir, "device-info.json"),
    JSON.stringify(
      {
        authDir,
        phoneNumber: LIFEOPS_SIMULATOR_OWNER.phone,
        uuid: "lifeops-simulator-signal-owner",
        deviceName: "LifeOps Simulator Signal",
      },
      null,
      2
    ),
    { encoding: "utf8", mode: 0o600 }
  );
  return authDir;
}

async function seedConnectorGrants(
  runtime: AgentRuntime,
  repository: LifeOpsRepository
): Promise<{ telegramTokenRef: string; signalTokenRef: string }> {
  const now = new Date().toISOString();
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
        id: "lifeops-simulator-owner",
        username: "mocked_lifeops_owner",
      },
      grantedScopes: [],
      capabilities: [...LIFEOPS_TELEGRAM_CAPABILITIES],
      tokenRef: telegramTokenRef,
      metadata: { mocked: true, simulator: "lifeops" },
      lastRefreshAt: now,
    })
  );
  await repository.upsertConnectorGrant(
    createLifeOpsConnectorGrant({
      agentId: runtime.agentId,
      provider: "signal",
      side: "owner",
      mode: "local",
      identity: {
        phoneNumber: LIFEOPS_SIMULATOR_OWNER.phone,
        uuid: "lifeops-simulator-signal-owner",
      },
      grantedScopes: [],
      capabilities: [...LIFEOPS_SIGNAL_CAPABILITIES],
      tokenRef: signalTokenRef,
      metadata: { mocked: true, simulator: "lifeops" },
      lastRefreshAt: now,
    })
  );
  await repository.upsertConnectorGrant(
    createLifeOpsConnectorGrant({
      agentId: runtime.agentId,
      provider: "discord",
      side: "owner",
      mode: "local",
      identity: { username: "mocked_owner", id: "lifeops-simulator-owner" },
      grantedScopes: [],
      capabilities: [...LIFEOPS_DISCORD_CAPABILITIES],
      tokenRef: null,
      metadata: { mocked: true, simulator: "lifeops", tabId: "tab_1" },
      lastRefreshAt: now,
    })
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
        Date.now() - 2 * 24 * 60 * 60 * 1000
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
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "lifeops-simulator-whatsapp",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              messages: LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.filter(
                (message) => message.channel === "whatsapp"
              ).map((message) => {
                const person = getLifeOpsSimulatorPerson(message.fromPersonKey);
                return {
                  id: message.id,
                  from: person.whatsappNumber,
                  timestamp: String(
                    Math.floor(
                      Date.parse(
                        lifeOpsSimulatorMessageTime(message.sentAtOffsetMs)
                      ) / 1000
                    )
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
  runtime: AgentRuntime
): Promise<LifeOpsSimulatorSeedResult> {
  await ensureLifeOpsSchema(runtime);
  const stateDir = stateDirFromEnv();
  writeTelegramMockSession(stateDir);

  const repository = new LifeOpsRepository(runtime);
  const service = new LifeOpsService(runtime);
  const { telegramTokenRef, signalTokenRef } = await seedConnectorGrants(
    runtime,
    repository
  );
  await service.authorizeDiscordConnector("owner", "desktop_browser");
  const relationships = await seedRelationships(service);
  const reminders = await seedReminders(service);
  for (const message of LIFEOPS_SIMULATOR_CHANNEL_MESSAGES) {
    await seedChatMemory(runtime, message);
  }
  const whatsapp = await service.ingestWhatsAppWebhook(
    whatsappWebhookPayload()
  );

  return {
    summary: lifeOpsSimulatorSummary(),
    relationships,
    chatMemories: LIFEOPS_SIMULATOR_CHANNEL_MESSAGES.length,
    reminders,
    whatsappBuffered: whatsapp.ingested,
    telegramTokenRef,
    signalTokenRef,
  };
}

export function lifeOpsSimulatorRunId(): string {
  return `lifeops-simulator-${crypto.randomUUID()}`;
}
