import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  extractPlugin,
  type PluginModuleShape,
  resolveOAuthDir,
} from "@elizaos/agent";
import type { AgentRuntime, Memory, Plugin, UUID } from "@elizaos/core";
import { ChannelType, createMessageMemory, logger } from "@elizaos/core";
import { InboxTriageRepository } from "../../src/inbox/repository.js";
import type { DeferredInboxDraft } from "../../src/inbox/types.js";
import { createApprovalQueue } from "../../src/lifeops/approval-queue.js";
import {
  createLifeOpsConnectorGrant,
  createLifeOpsGmailSyncState,
  LifeOpsRepository,
} from "../../src/lifeops/repository.js";
import { LifeOpsService } from "../../src/lifeops/service.js";

export const GOOGLE_CLIENT_ID = "assistant-user-journeys-google-client";

export type MorningBriefSeedContext = {
  calendarTitles: string[];
  unreadChannels: string[];
  pendingDraftRecipient: string;
  pendingDraftSubject: string;
  pendingDraftRequestId: string;
  followupContact: string;
  followupReason: string;
  documentBlockers: string[];
};

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function containsAllFragments(
  text: string,
  fragments: string[],
): boolean {
  const normalized = normalizeText(text);
  return fragments.every((fragment) =>
    normalized.includes(normalizeText(fragment)),
  );
}

export async function loadPlugin(name: string): Promise<Plugin | null> {
  try {
    return extractPlugin(
      (await import(name)) as PluginModuleShape,
    ) as Plugin | null;
  } catch (error) {
    logger.warn(
      `[assistant-user-journeys-morning-brief-live] failed to load ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

export async function ensureRoom(args: {
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

export async function seedRoomMessages(
  runtime: AgentRuntime,
  roomId: UUID,
  items: Array<{
    entityId: UUID;
    text: string;
    deltaMs: number;
    source: string;
  }>,
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
          source: item.source,
        },
        createdAt: now + item.deltaMs,
      } as Memory,
      "messages",
    );
  }
}

export async function seedMorningBriefFixtures(args: {
  runtime: AgentRuntime;
  ownerId: UUID;
  dmRoomId: UUID;
  stateDir: string;
}): Promise<MorningBriefSeedContext> {
  await LifeOpsRepository.bootstrapSchema(args.runtime);
  const repository = await seedGoogleConnector(args.runtime, args.stateDir);
  const agentId = String(args.runtime.agentId);
  const nowIso = new Date().toISOString();
  const service = new LifeOpsService(args.runtime);
  const triageRepo = new InboxTriageRepository(args.runtime);
  const approvalQueue = createApprovalQueue(args.runtime, {
    agentId: args.runtime.agentId,
  });

  const calendarTitles: string[] = [];
  const documentBlockers = [
    "Clinic intake packet",
    "Investor diligence packet",
  ];

  await seedGmail(repository, agentId, nowIso);
  await seedUnreadChannels(args.runtime, args.ownerId, triageRepo);

  const frontier = await service.upsertRelationship({
    name: "Frontier Tower",
    primaryChannel: "email",
    primaryHandle: "ops@frontiertower.example.com",
    email: "ops@frontiertower.example.com",
    phone: null,
    notes: "Property walkthrough vendor",
    tags: [],
    relationshipType: "vendor",
    lastContactedAt: new Date(
      Date.now() - 21 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    metadata: {},
  });
  const followUp = await service.createFollowUp({
    relationshipId: frontier.id,
    dueAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    reason: "Repair the missed walkthrough and reschedule.",
    priority: 1,
    draft: null,
    completedAt: null,
    metadata: {},
  });

  const pendingDraft: DeferredInboxDraft = {
    triageEntryId: "seeded-marco-triage-entry",
    source: "gmail",
    gmailMessageId: "morning-brief-gmail-marco",
    draftText:
      "I reviewed the investor diligence packet and can send comments by 2pm today.",
    deepLink:
      "https://mail.google.com/mail/u/shawmakesmagic%40gmail.com/#inbox/morning-brief-gmail-marco",
    channelName: "Marco Alvarez <marco@northstar.example.com>",
    senderName: "Marco Alvarez",
  };

  const approvalRequest = await approvalQueue.enqueue({
    requestedBy: "background-job:draft-aging-sweeper",
    subjectUserId: String(args.ownerId),
    action: "send_email",
    payload: {
      action: "send_email",
      to: ["marco@northstar.example.com"],
      cc: [],
      bcc: [],
      subject: "Re: Investor diligence packet",
      body: pendingDraft.draftText,
      threadId: "morning-brief-marco-thread",
    },
    channel: "email",
    reason: "Draft is ready and still waiting for owner sign-off.",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  await args.runtime.createMemory(
    createMessageMemory({
      id: crypto.randomUUID() as UUID,
      entityId: args.runtime.agentId,
      roomId: args.dmRoomId,
      metadata: {
        type: "assistant_message",
        entityName: "Eliza",
      },
      content: {
        text: "Pending draft for Marco Alvarez is still waiting for sign-off about the investor diligence packet.",
        source: "assistant",
        channelType: ChannelType.DM,
        inboxDraft: pendingDraft,
        data: {
          inboxDraft: pendingDraft,
          approvalRequestId: approvalRequest.id,
        },
      },
    }),
    "messages",
  );

  await args.runtime.createMemory(
    {
      id: crypto.randomUUID() as UUID,
      entityId: args.runtime.agentId,
      agentId: args.runtime.agentId,
      roomId: args.dmRoomId,
      content: {
        text: "Follow-up still overdue: Frontier Tower needs the missed walkthrough repaired and rescheduled.",
        type: "followup_overdue_digest",
        source: "followup-tracker",
        data: {
          overdue: [
            {
              relationshipId: frontier.id,
              displayName: frontier.name,
              daysOverdue: 1,
              thresholdDays: 0,
              reason: followUp.reason,
            },
          ],
        },
      },
      createdAt: Date.now() - 15_000,
    } as Memory,
    "messages",
  );

  await args.runtime.createMemory(
    {
      id: crypto.randomUUID() as UUID,
      entityId: args.runtime.agentId,
      agentId: args.runtime.agentId,
      roomId: args.dmRoomId,
      content: {
        text: "Document blockers: Clinic intake packet still needs signature and the investor diligence packet still needs review before noon.",
        source: "assistant",
      },
      createdAt: Date.now() - 10_000,
    } as Memory,
    "messages",
  );

  return {
    calendarTitles,
    unreadChannels: ["gmail", "telegram", "discord"],
    pendingDraftRecipient: pendingDraft.senderName,
    pendingDraftSubject: "Investor diligence packet",
    pendingDraftRequestId: approvalRequest.id,
    followupContact: frontier.name,
    followupReason: followUp.reason,
    documentBlockers,
  };
}

async function seedGoogleConnector(
  runtime: AgentRuntime,
  stateDir: string,
): Promise<LifeOpsRepository> {
  const repository = new LifeOpsRepository(runtime);
  const agentId = String(runtime.agentId);
  const tokenRef = `${agentId}/owner/local.json`;
  const grantId = "morning-brief-google-grant";
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
          "https://www.googleapis.com/auth/drive.readonly",
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
        "https://www.googleapis.com/auth/drive.readonly",
      ],
      capabilities: [
        "google.basic_identity",
        "google.calendar.read",
        "google.gmail.triage",
        "google.drive.read",
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

async function seedGmail(
  repository: LifeOpsRepository,
  agentId: string,
  nowIso: string,
): Promise<void> {
  const grantId = "morning-brief-google-grant";
  const accountEmail = "shawmakesmagic@gmail.com";
  const messages = [
    {
      id: "morning-brief-gmail-tax",
      externalId: "morning-brief-gmail-tax-ext",
      agentId,
      provider: "google" as const,
      side: "owner" as const,
      grantId,
      accountEmail,
      threadId: "morning-brief-thread-tax",
      subject: "Wire cutoff today at 2pm for property tax payment",
      from: "Escrow Ops <escrow@westbridge.example.com>",
      fromEmail: "escrow@westbridge.example.com",
      replyTo: "escrow@westbridge.example.com",
      to: ["shawmakesmagic@gmail.com"],
      cc: [],
      snippet: "The property tax wire cutoff is today at 2pm.",
      receivedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      isUnread: true,
      isImportant: true,
      likelyReplyNeeded: true,
      triageScore: 96,
      triageReason: "Same-day payment deadline.",
      labels: ["INBOX", "UNREAD", "IMPORTANT"],
      htmlLink: null,
      metadata: { category: "finance" },
      syncedAt: nowIso,
      updatedAt: nowIso,
    },
    {
      id: "morning-brief-gmail-clinic-doc",
      externalId: "morning-brief-gmail-clinic-doc-ext",
      agentId,
      provider: "google" as const,
      side: "owner" as const,
      grantId,
      accountEmail,
      threadId: "morning-brief-thread-clinic-doc",
      subject: "Please sign the clinic intake packet before Thursday",
      from: "Northside Clinic <intake@northside.example.com>",
      fromEmail: "intake@northside.example.com",
      replyTo: "intake@northside.example.com",
      to: ["shawmakesmagic@gmail.com"],
      cc: [],
      snippet:
        "The clinic intake packet still needs your signature before Thursday morning.",
      receivedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      isUnread: true,
      isImportant: true,
      likelyReplyNeeded: true,
      triageScore: 90,
      triageReason: "Blocking medical paperwork.",
      labels: ["INBOX", "UNREAD", "IMPORTANT"],
      htmlLink: null,
      metadata: { category: "documents" },
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

async function seedUnreadChannels(
  runtime: AgentRuntime,
  ownerId: UUID,
  triageRepo: InboxTriageRepository,
): Promise<void> {
  const worldId = crypto.randomUUID() as UUID;
  const telegramRoomId = crypto.randomUUID() as UUID;
  const discordRoomId = crypto.randomUUID() as UUID;
  const samId = crypto.randomUUID() as UUID;
  const opsId = crypto.randomUUID() as UUID;

  await ensureRoom({
    runtime,
    entityId: samId,
    roomId: telegramRoomId,
    worldId,
    source: "telegram",
    channelId: "telegram-morning-brief",
    userName: "sam",
    type: ChannelType.DM,
  });
  await runtime.ensureParticipantInRoom(ownerId, telegramRoomId);

  await ensureRoom({
    runtime,
    entityId: opsId,
    roomId: discordRoomId,
    worldId,
    source: "discord",
    channelId: "discord-investor-ops",
    userName: "investor-ops",
    type: ChannelType.GROUP,
  });
  await runtime.ensureParticipantInRoom(ownerId, discordRoomId);

  await seedRoomMessages(runtime, telegramRoomId, [
    {
      entityId: samId,
      text: "Rowan pickup moved to 5:30pm. Please confirm you saw this.",
      deltaMs: -20 * 60 * 1000,
      source: "telegram",
    },
  ]);
  await seedRoomMessages(runtime, discordRoomId, [
    {
      entityId: opsId,
      text: "Please review the investor diligence packet doc before noon and drop your comments in-thread.",
      deltaMs: -15 * 60 * 1000,
      source: "discord",
    },
  ]);

  await triageRepo.storeTriage({
    source: "gmail",
    sourceMessageId: "morning-brief-gmail-tax",
    channelName: "Escrow Ops",
    channelType: "email",
    deepLink:
      "https://mail.google.com/mail/u/shawmakesmagic%40gmail.com/#inbox/morning-brief-gmail-tax",
    classification: "urgent",
    urgency: "high",
    confidence: 0.98,
    snippet: "Wire cutoff today at 2pm for property tax payment.",
    senderName: "Escrow Ops",
    triageReasoning: "Hard same-day finance deadline.",
    suggestedResponse: "I saw this. I'll confirm the wire status before 2pm.",
  });

  await triageRepo.storeTriage({
    source: "gmail",
    sourceMessageId: "morning-brief-gmail-clinic-doc",
    channelName: "Northside Clinic",
    channelType: "email",
    deepLink:
      "https://mail.google.com/mail/u/shawmakesmagic%40gmail.com/#inbox/morning-brief-gmail-clinic-doc",
    classification: "urgent",
    urgency: "high",
    confidence: 0.96,
    snippet:
      "Clinic intake packet still needs your signature before Thursday morning.",
    senderName: "Northside Clinic",
    triageReasoning: "Document blocker tied to an upcoming appointment.",
    suggestedResponse: "I will review and sign the packet today.",
  });

  await triageRepo.storeTriage({
    source: "telegram",
    sourceRoomId: String(telegramRoomId),
    sourceEntityId: String(samId),
    sourceMessageId: "telegram-morning-brief-rowan",
    channelName: "Sam",
    channelType: "dm",
    deepLink: "telegram://resolve?domain=sam",
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.91,
    snippet: "Rowan pickup moved to 5:30pm. Please confirm.",
    senderName: "Sam",
    triageReasoning: "Family logistics need acknowledgment.",
    suggestedResponse: "Saw it. I'll plan for the 5:30 pickup.",
  });

  await triageRepo.storeTriage({
    source: "discord",
    sourceRoomId: String(discordRoomId),
    sourceEntityId: String(opsId),
    sourceMessageId: "discord-morning-brief-diligence-doc",
    channelName: "#investor-ops",
    channelType: "group",
    deepLink: "https://discord.com/channels/seed/investor-ops",
    classification: "needs_reply",
    urgency: "medium",
    confidence: 0.9,
    snippet:
      "Please review the investor diligence packet doc before noon and add your comments.",
    senderName: "Investor Ops",
    triageReasoning: "Work document is blocking the next meeting.",
    suggestedResponse:
      "I will review the diligence packet and send comments before noon.",
  });
}
