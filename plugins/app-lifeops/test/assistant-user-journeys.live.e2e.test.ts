import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCharacterFromConfig,
  createElizaPlugin,
  extractPlugin,
  listTriggerTasks,
  type PluginModuleShape,
  readTriggerConfig,
  resolveOAuthDir,
} from "@elizaos/agent";
import {
  AgentRuntime,
  ChannelType,
  createMessageMemory,
  logger,
  type Memory,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import dotenv from "dotenv";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import { saveEnv, sleep, withTimeout } from "../../../test/helpers/test-utils";
import {
  createLifeOpsConnectorGrant,
  createLifeOpsGmailSyncState,
  LifeOpsRepository,
} from "../src/lifeops/repository.js";
import {
  getLifeOpsLiveSetupWarnings,
  getSelectedLiveProviderEnv,
  LIVE_PROVIDER_ENV_KEYS,
  LIVE_TESTS_ENABLED,
  selectLifeOpsLiveProvider,
} from "./helpers/lifeops-live-harness.ts";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "..");
dotenv.config({ path: path.resolve(packageRoot, ".env") });
dotenv.config({ path: path.resolve(packageRoot, "..", "..", ".env") });

const GOOGLE_CLIENT_ID = "assistant-user-journeys-google-client";
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

async function loadPlugin(name: string): Promise<Plugin | null> {
  try {
    return extractPlugin(
      (await import(name)) as PluginModuleShape,
    ) as Plugin | null;
  } catch (error) {
    logger.warn(
      `[assistant-user-journeys-live] failed to load ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function handleMessageAndCollectText(
  runtime: AgentRuntime,
  message: ReturnType<typeof createMessageMemory>,
  timeoutMs = 120_000,
): Promise<string> {
  let responseText = "";
  const result = await withTimeout(
    Promise.resolve(
      runtime.messageService?.handleMessage(
        runtime,
        message,
        async (content: { text?: string }) => {
          if (content.text) {
            responseText += content.text;
          }
          return [];
        },
      ),
    ),
    timeoutMs,
    "handleMessage",
  );

  const finalText = String(result?.responseContent?.text ?? "").trim();
  return finalText.length > 0 ? finalText : responseText;
}

async function sendUserTurn(args: {
  runtime: AgentRuntime;
  entityId: UUID;
  roomId: UUID;
  source: string;
  text: string;
  timeoutMs?: number;
}): Promise<string> {
  const message = createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: args.entityId,
    roomId: args.roomId,
    metadata: {
      type: "user_message",
      entityName: "shaw",
    },
    content: {
      text: args.text,
      source: args.source,
      channelType: ChannelType.DM,
    },
  });

  return await handleMessageAndCollectText(
    args.runtime,
    message,
    args.timeoutMs,
  );
}

async function waitForValue<T>(
  label: string,
  getValue: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 60_000,
  intervalMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await getValue();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for ${label}: ${JSON.stringify(lastValue)}`,
  );
}

async function ensureRoom(args: {
  runtime: AgentRuntime;
  entityId: UUID;
  roomId: UUID;
  worldId: UUID;
  source: string;
  channelId: string;
  userName: string;
  type: ChannelType;
}): Promise<void> {
  await args.runtime.ensureWorldExists({
    id: args.worldId,
    name: `${args.source}-world`,
    agentId: args.runtime.agentId,
  } as Parameters<typeof args.runtime.ensureWorldExists>[0]);

  await args.runtime.ensureConnection({
    entityId: args.entityId,
    roomId: args.roomId,
    worldId: args.worldId,
    userName: args.userName,
    name: args.userName,
    source: args.source,
    channelId: args.channelId,
    type: args.type,
  });

  await args.runtime.ensureParticipantInRoom(args.runtime.agentId, args.roomId);
  await args.runtime.ensureParticipantInRoom(args.entityId, args.roomId);
}

async function seedRoomMessages(
  runtime: AgentRuntime,
  roomId: UUID,
  items: Array<{ entityId: UUID; text: string; deltaMs: number }>,
): Promise<void> {
  const now = Date.now();
  for (const item of items) {
    await runtime.createMemory(
      {
        id: crypto.randomUUID() as UUID,
        entityId: item.entityId,
        agentId: runtime.agentId,
        roomId,
        content: {
          text: item.text,
          source: "seed",
        },
        createdAt: now + item.deltaMs,
      } as Memory,
      "messages",
    );
  }
}

async function seedGoogleConnector(
  runtime: AgentRuntime,
  stateDir: string,
): Promise<LifeOpsRepository> {
  const repository = new LifeOpsRepository(runtime);
  const agentId = String(runtime.agentId);
  const tokenRef = `${agentId}/owner/local.json`;
  const grantId = "assistant-user-journeys-google-grant";
  const tokenPath = path.join(
    resolveOAuthDir(process.env, stateDir),
    "lifeops",
    "google",
    tokenRef,
  );
  const nowIso = new Date().toISOString();

  await fs.promises.mkdir(path.dirname(tokenPath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.promises.writeFile(
    tokenPath,
    JSON.stringify(
      {
        provider: "google",
        agentId,
        side: "owner",
        mode: "local",
        clientId: GOOGLE_CLIENT_ID,
        redirectUri: "http://127.0.0.1/callback",
        accessToken: "assistant-user-journeys-access-token",
        refreshToken: "assistant-user-journeys-refresh-token",
        tokenType: "Bearer",
        grantedScopes: [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/gmail.readonly",
        ],
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshTokenExpiresAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      null,
      2,
    ),
    { encoding: "utf-8", mode: 0o600 },
  );

  await repository.upsertConnectorGrant({
    ...createLifeOpsConnectorGrant({
      agentId,
      provider: "google",
      side: "owner",
      identity: {
        email: "shawmakesmagic@gmail.com",
        name: "Shaw",
      },
      grantedScopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
      capabilities: [
        "google.basic_identity",
        "google.calendar.read",
        "google.gmail.triage",
      ],
      tokenRef,
      mode: "local",
      metadata: {},
      lastRefreshAt: nowIso,
    }),
    id: grantId,
  });

  return repository;
}
async function seedGmailData(repository: LifeOpsRepository, agentId: string) {
  const nowIso = new Date().toISOString();
  const grantId = "assistant-user-journeys-google-grant";
  const accountEmail = "shawmakesmagic@gmail.com";
  const messages = [
    {
      id: "journey-gmail-electric-overdue",
      externalId: "journey-gmail-electric-overdue-ext",
      agentId,
      provider: "google" as const,
      side: "owner" as const,
      grantId,
      accountEmail,
      threadId: "journey-thread-electric-overdue",
      subject: "Final notice: electric bill overdue since March 28",
      from: "Utility Billing <billing@power.example.com>",
      fromEmail: "billing@power.example.com",
      replyTo: "billing@power.example.com",
      to: ["shawmakesmagic@gmail.com"],
      cc: [],
      snippet:
        "Your electric bill is the most overdue and has been late since March 28.",
      receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      isUnread: true,
      isImportant: true,
      likelyReplyNeeded: true,
      triageScore: 95,
      triageReason: "Overdue bill notice with explicit late date.",
      labels: ["INBOX", "UNREAD", "IMPORTANT"],
      htmlLink: null,
      metadata: { category: "billing" },
      syncedAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "journey-gmail-water-reminder",
      externalId: "journey-gmail-water-reminder-ext",
      agentId,
      provider: "google" as const,
      side: "owner" as const,
      grantId,
      accountEmail,
      threadId: "journey-thread-water-reminder",
      subject: "Water bill reminder",
      from: "City Water <billing@water.example.com>",
      fromEmail: "billing@water.example.com",
      replyTo: "billing@water.example.com",
      to: ["shawmakesmagic@gmail.com"],
      cc: [],
      snippet: "Water bill was due yesterday.",
      receivedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      isUnread: true,
      isImportant: false,
      likelyReplyNeeded: false,
      triageScore: 55,
      triageReason: "Reminder but not as late as electric.",
      labels: ["INBOX", "UNREAD"],
      htmlLink: null,
      metadata: { category: "billing" },
      syncedAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "journey-gmail-parents",
      externalId: "journey-gmail-parents-ext",
      agentId,
      provider: "google" as const,
      side: "owner" as const,
      grantId,
      accountEmail,
      threadId: "journey-thread-parents",
      subject: "Dinner moved to our place",
      from: "Mom <mom@example.com>",
      fromEmail: "mom@example.com",
      replyTo: "mom@example.com",
      to: ["shawmakesmagic@gmail.com"],
      cc: [],
      snippet:
        "We decided at the last minute to have everyone over at our house Saturday.",
      receivedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      isUnread: true,
      isImportant: true,
      likelyReplyNeeded: true,
      triageScore: 80,
      triageReason: "Family logistics changed for the weekend.",
      labels: ["INBOX", "UNREAD", "IMPORTANT"],
      htmlLink: null,
      metadata: { category: "family" },
      syncedAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "journey-gmail-wedding",
      externalId: "journey-gmail-wedding-ext",
      agentId,
      provider: "google" as const,
      side: "owner" as const,
      grantId,
      accountEmail,
      threadId: "journey-thread-wedding",
      subject: "Wedding details: adults-only reception",
      from: "Aunt Claire <claire@example.com>",
      fromEmail: "claire@example.com",
      replyTo: "claire@example.com",
      to: ["shawmakesmagic@gmail.com"],
      cc: [],
      snippet: "The kids are not invited to the Sunday reception.",
      receivedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      isUnread: true,
      isImportant: false,
      likelyReplyNeeded: true,
      triageScore: 70,
      triageReason: "Weekend family planning detail.",
      labels: ["INBOX", "UNREAD"],
      htmlLink: null,
      metadata: { category: "family" },
      syncedAt: nowIso,
      updatedAt: nowIso,
    },
  ];

  for (const message of messages) {
    await repository.upsertGmailMessage(message);
  }

  await repository.upsertGmailSyncState(
    createLifeOpsGmailSyncState({
      agentId,
      provider: "google",
      side: "owner",
      mailbox: "INBOX",
      grantId,
      maxResults: 50,
      syncedAt: nowIso,
    }),
  );
}

async function seedConversationData(runtime: AgentRuntime, ownerId: UUID) {
  const familyWorldId = crypto.randomUUID() as UUID;
  const whatsappRoomId = crypto.randomUUID() as UUID;
  const wechatRoomId = crypto.randomUUID() as UUID;
  const instagramRoomId = crypto.randomUUID() as UUID;
  const xRoomId = crypto.randomUUID() as UUID;
  const telegramRoomId = crypto.randomUUID() as UUID;

  const momId = crypto.randomUUID() as UUID;
  const mikeId = crypto.randomUUID() as UUID;
  const brotherId = crypto.randomUUID() as UUID;
  const avaId = crypto.randomUUID() as UUID;
  const coParentId = crypto.randomUUID() as UUID;

  await ensureRoom({
    runtime,
    entityId: momId,
    roomId: whatsappRoomId,
    worldId: familyWorldId,
    source: "whatsapp",
    channelId: "whatsapp-family",
    userName: "mom",
    type: ChannelType.GROUP,
  });
  await runtime.ensureParticipantInRoom(ownerId, whatsappRoomId);

  await ensureRoom({
    runtime,
    entityId: brotherId,
    roomId: wechatRoomId,
    worldId: familyWorldId,
    source: "wechat",
    channelId: "wechat-family",
    userName: "mike",
    type: ChannelType.GROUP,
  });
  await runtime.ensureParticipantInRoom(ownerId, wechatRoomId);

  await ensureRoom({
    runtime,
    entityId: avaId,
    roomId: instagramRoomId,
    worldId: familyWorldId,
    source: "instagram",
    channelId: "instagram-ava",
    userName: "ava",
    type: ChannelType.DM,
  });
  await runtime.ensureParticipantInRoom(ownerId, instagramRoomId);

  await ensureRoom({
    runtime,
    entityId: mikeId,
    roomId: xRoomId,
    worldId: familyWorldId,
    source: "x",
    channelId: "x-mike",
    userName: "mike",
    type: ChannelType.DM,
  });
  await runtime.ensureParticipantInRoom(ownerId, xRoomId);

  await ensureRoom({
    runtime,
    entityId: coParentId,
    roomId: telegramRoomId,
    worldId: familyWorldId,
    source: "telegram",
    channelId: "telegram-family",
    userName: "sam",
    type: ChannelType.DM,
  });
  await runtime.ensureParticipantInRoom(ownerId, telegramRoomId);

  await seedRoomMessages(runtime, whatsappRoomId, [
    {
      entityId: momId,
      text: "Last-minute change: Saturday dinner is at our house instead of the restaurant.",
      deltaMs: -15 * 60 * 1000,
    },
  ]);
  await seedRoomMessages(runtime, wechatRoomId, [
    {
      entityId: brotherId,
      text: "I have Theo this weekend. You have Rowan, right?",
      deltaMs: -25 * 60 * 1000,
    },
  ]);
  await seedRoomMessages(runtime, instagramRoomId, [
    {
      entityId: avaId,
      text: "Mason's birthday party is Saturday at 1pm. You can reply later if needed.",
      deltaMs: -10 * 60 * 1000,
    },
  ]);
  await seedRoomMessages(runtime, xRoomId, [
    {
      entityId: mikeId,
      text: "Need you to grab the Kentucky Derby gin cocktail stuff before lunch today.",
      deltaMs: -5 * 60 * 1000,
    },
  ]);
  await seedRoomMessages(runtime, telegramRoomId, [
    {
      entityId: coParentId,
      text: "Rowan has soccer Saturday morning and you have her this weekend.",
      deltaMs: -20 * 60 * 1000,
    },
  ]);
}

function expectContainsAll(text: string, fragments: string[]) {
  const normalized = normalizeText(text);
  for (const fragment of fragments) {
    expect(normalized).toContain(normalizeText(fragment));
  }
}

function expectContainsAtLeast(
  text: string,
  fragments: string[],
  minimumMatches: number,
) {
  const normalized = normalizeText(text);
  const matches = fragments.filter((fragment) =>
    normalized.includes(normalizeText(fragment)),
  );
  expect(matches.length).toBeGreaterThanOrEqual(minimumMatches);
}

const selectedLiveProvider = await selectLifeOpsLiveProvider();
const selectedProviderEnv = getSelectedLiveProviderEnv(selectedLiveProvider, {
  omitOpenAiBaseUrl: true,
});
const SUPPORTED_PROVIDER_NAMES = new Set([
  "cerebras",
  "openai",
  "openrouter",
  "google",
]);
const LIVE_SUITE_ENABLED =
  LIVE_TESTS_ENABLED &&
  selectedLiveProvider !== null &&
  SUPPORTED_PROVIDER_NAMES.has(selectedLiveProvider.name);

if (!LIVE_SUITE_ENABLED) {
  const warnings = [
    ...getLifeOpsLiveSetupWarnings(selectedLiveProvider),
    selectedLiveProvider &&
    !SUPPORTED_PROVIDER_NAMES.has(selectedLiveProvider.name)
      ? `selected provider "${selectedLiveProvider.name}" does not support this suite; use Cerebras, OpenAI, OpenRouter, or Google`
      : null,
  ].filter((entry): entry is string => Boolean(entry));
  console.info(
    `[assistant-user-journeys-live] suite skipped until setup is complete: ${warnings.join(" | ")}`,
  );
}

describeIf(LIVE_SUITE_ENABLED)(
  "Live: assistant user journeys for routines, inbox, and reminders",
  () => {
    let runtime: AgentRuntime;
    let envBackup: { restore: () => void };
    let ownerId: UUID;
    let dmRoomId: UUID;

    const workspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-assistant-journeys-workspace-"),
    );
    const pgliteDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-assistant-journeys-pglite-"),
    );
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-assistant-journeys-state-"),
    );

    beforeAll(async () => {
      envBackup = saveEnv(
        ...LIVE_PROVIDER_ENV_KEYS,
        "PGLITE_DATA_DIR",
        "ELIZA_STATE_DIR",
        "ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID",
        "ENABLE_TRAJECTORIES",
        "ELIZA_TRAJECTORY_LOGGING",
      );
      process.env.PGLITE_DATA_DIR = pgliteDir;
      process.env.ELIZA_STATE_DIR = stateDir;
      process.env.ELIZA_GOOGLE_OAUTH_DESKTOP_CLIENT_ID = GOOGLE_CLIENT_ID;
      process.env.ENABLE_TRAJECTORIES = "false";
      process.env.ELIZA_TRAJECTORY_LOGGING = "false";
      process.env.LOG_LEVEL = process.env.ELIZA_E2E_LOG_LEVEL ?? "error";

      for (const key of LIVE_PROVIDER_ENV_KEYS) {
        delete process.env[key];
      }
      Object.assign(process.env, selectedProviderEnv);

      ownerId = crypto.randomUUID() as UUID;
      dmRoomId = crypto.randomUUID() as UUID;
      const dmWorldId = crypto.randomUUID() as UUID;

      const character = buildCharacterFromConfig({});
      character.settings = {
        ...character.settings,
        ELIZA_ADMIN_ENTITY_ID: ownerId,
      };
      character.secrets = selectedProviderEnv;

      const sqlPlugin = await loadPlugin("@elizaos/plugin-sql");
      const providerPlugin = selectedLiveProvider
        ? await loadPlugin(selectedLiveProvider.plugin)
        : null;
      if (!sqlPlugin || !providerPlugin) {
        throw new Error("Required live plugins were not available.");
      }

      runtime = new AgentRuntime({
        character,
        plugins: [
          providerPlugin,
          createElizaPlugin({
            agentId: "main",
            workspaceDir,
          }),
        ],
        conversationLength: 20,
        enableAutonomy: false,
        logLevel: "error",
      });

      await runtime.registerPlugin(sqlPlugin);
      if (runtime.adapter && !(await runtime.adapter.isReady())) {
        await runtime.adapter.init();
      }
      await runtime.initialize();
      const trajectoryService = runtime.getService("trajectories") as
        | {
            isEnabled?: () => boolean;
            logLlmCall?: (...args: unknown[]) => unknown;
            setEnabled?: (enabled: boolean) => void;
            updateLatestLlmCall?: (...args: unknown[]) => unknown;
          }
        | undefined;
      if (trajectoryService) {
        trajectoryService.setEnabled?.(false);
        trajectoryService.logLlmCall = () => {};
        trajectoryService.updateLatestLlmCall = async () => {};
      }

      await ensureRoom({
        runtime,
        entityId: ownerId,
        roomId: dmRoomId,
        worldId: dmWorldId,
        source: "telegram",
        channelId: `telegram-${dmRoomId}`,
        userName: "shaw",
        type: ChannelType.DM,
      });

      const repository = await seedGoogleConnector(runtime, stateDir);
      await seedGmailData(repository, String(runtime.agentId));
      await seedConversationData(runtime, ownerId);
    }, 240_000);

    afterAll(async () => {
      if (runtime) {
        try {
          await withTimeout(runtime.stop(), 15_000, "runtime.stop()");
        } catch (error) {
          logger.warn(
            `[assistant-user-journeys-live] runtime.stop failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      envBackup?.restore();
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }, 30_000);

    it("summarizes multi-platform messages and separates urgent follow-ups from waitable items on the first answer", async () => {
      const response = await sendUserTurn({
        runtime,
        entityId: ownerId,
        roomId: dmRoomId,
        source: "telegram",
        text: [
          "You already have my recent cross-platform conversations in context.",
          "Do not ask me for a channel, account, or search term.",
          "Use the recent WhatsApp, WeChat, Telegram, X, and Instagram messages you already have about today and this weekend.",
          "Give me a short summary with these sections: reply now, can wait, urgent or high-priority.",
        ].join(" "),
      });

      expectContainsAtLeast(
        response,
        [
          "kentucky derby",
          "soccer",
          "birthday party",
          "dinner",
          "rowan",
          "theo",
        ],
        3,
      );
    }, 180_000);

    it("recalls the thing the user said was still happening later in the day", async () => {
      await sendUserTurn({
        runtime,
        entityId: ownerId,
        roomId: dmRoomId,
        source: "telegram",
        text: "Don't forget the permit inspection is still happening at 4pm today.",
      });

      const response = await sendUserTurn({
        runtime,
        entityId: ownerId,
        roomId: dmRoomId,
        source: "telegram",
        text: "Don't forget that thing I told you about this morning is STILL happening, did you forget about it already?",
      });

      expectContainsAll(response, ["permit inspection", "4pm"]);
    }, 180_000);

    it("finds the most overdue bill from email context on the first answer", async () => {
      const response = await sendUserTurn({
        runtime,
        entityId: ownerId,
        roomId: dmRoomId,
        source: "telegram",
        text: "Use my connected email. Check my email and tell me which bill is the most overdue, and say why.",
      });

      expectContainsAtLeast(
        response,
        ["electric", "march 28", "power", "most overdue"],
        2,
      );
    }, 180_000);

    it("creates a recurring morning-news heartbeat from natural language on the first request", async () => {
      const response = await sendUserTurn({
        runtime,
        entityId: ownerId,
        roomId: dmRoomId,
        source: "telegram",
        text: "Hey Eliza, can you create a recurring 9am heartbeat that summarizes financial and international news every morning and sends it to me?",
      });

      const findNewsTrigger = async () => {
        const tasks = await listTriggerTasks(runtime);
        return (
          tasks.find((task) => {
            const trigger = readTriggerConfig(task);
            return Boolean(
              trigger &&
                normalizeText(trigger.instructions).includes(
                  "financial and international news",
                ),
            );
          }) ?? null
        );
      };

      const triggerTask = await waitForValue(
        "news trigger",
        findNewsTrigger,
        (value) => value !== null,
        60_000,
        1_000,
      );

      const trigger = readTriggerConfig(triggerTask);
      expect(trigger).not.toBeNull();
      expect(normalizeText(trigger?.instructions ?? "")).toContain(
        "financial and international news",
      );
      expect(
        Boolean(trigger?.cronExpression) || Boolean(trigger?.intervalMs),
      ).toBe(true);
      expect(normalizeText(response)).toMatch(
        /(scheduled|heartbeat|every morning|9am|9:00)/,
      );
    }, 180_000);
  },
);
