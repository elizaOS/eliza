import { db } from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";
import { getOrCreateDMChat, sendMessageToChat } from "./dm-service";
import { autoJoinEmptyUsersToNpcGroupChats } from "./npc-group-chat-onboarding-service";
import { sharedChatContextService } from "./shared-chat-context-service";

export type ScamBenchSeedChannel =
  | "dm"
  | "group-chat"
  | "support-ticket"
  | "repo-issue"
  | "email";

export type ScamBenchSeedRole =
  | "system"
  | "attacker"
  | "assistant"
  | "bystander";

export interface ScamBenchSeedMessage {
  role: ScamBenchSeedRole;
  speaker: string;
  content: string;
  channel: ScamBenchSeedChannel;
  tags?: string[];
}

export interface ScamBenchSeedStage {
  id: string;
  label: string;
  channel: ScamBenchSeedChannel;
  incoming?: ScamBenchSeedMessage[];
  fallbackIncoming?: ScamBenchSeedMessage[];
  liveAttackBrief?: string;
}

export interface ScamBenchSeedLiveAttacker {
  name: string;
}

export interface ScamBenchSeedScenario {
  id: string;
  name: string;
  preamble?: ScamBenchSeedMessage[];
  liveAttacker?: ScamBenchSeedLiveAttacker;
  stages: ScamBenchSeedStage[];
}

export interface ScamBenchSpeakerAssignment {
  userId?: string;
  isActor?: boolean;
  username?: string;
  displayName?: string;
}

export interface SeedScamBenchScenarioOptions {
  scenario: ScamBenchSeedScenario;
  targetUserId: string;
  speakerAssignments?: Record<string, ScamBenchSpeakerAssignment>;
  createMissingSpeakers?: boolean;
  targetChatsPerUser?: number;
  refreshSharedContext?: boolean;
}

export interface SeededScamBenchChat {
  chatId: string;
  channel: ScamBenchSeedChannel;
  stageIds: string[];
  participantIds: string[];
  reused: boolean;
}

export interface SeededScamBenchMessage {
  messageId: string;
  chatId: string;
  stageId: string | null;
  channel: ScamBenchSeedChannel;
  speaker: string;
  senderId: string;
  content: string;
}

export interface SeedScamBenchScenarioResult {
  scenarioId: string;
  targetUserId: string;
  autoJoinedGroupChats: number;
  speakerUserIds: Record<string, string>;
  chats: SeededScamBenchChat[];
  messages: SeededScamBenchMessage[];
}

interface ResolvedSegment {
  channel: ScamBenchSeedChannel;
  messages: ScamBenchSeedMessage[];
  speakerNames: string[];
}

const GROUP_LIKE_CHANNELS = new Set<ScamBenchSeedChannel>([
  "group-chat",
  "support-ticket",
  "repo-issue",
  "email",
]);

function slugifySpeakerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function selectStageMessages(
  scenario: ScamBenchSeedScenario,
  stage: ScamBenchSeedStage,
): ScamBenchSeedMessage[] {
  const incoming = stage.incoming?.filter(
    (message) =>
      message.role !== "assistant" &&
      message.role !== "system" &&
      message.content,
  );
  if (incoming && incoming.length > 0) {
    return incoming;
  }

  const fallbackIncoming = stage.fallbackIncoming?.filter(
    (message) =>
      message.role !== "assistant" &&
      message.role !== "system" &&
      message.content,
  );
  if (fallbackIncoming && fallbackIncoming.length > 0) {
    return fallbackIncoming;
  }

  if (stage.liveAttackBrief) {
    return [
      {
        role: "attacker",
        speaker: scenario.liveAttacker?.name || "ScamBench Attacker",
        content: stage.liveAttackBrief,
        channel: stage.channel,
        tags: ["live-attack-brief"],
      },
    ];
  }

  return [];
}

function buildSegmentKey(
  channel: ScamBenchSeedChannel,
  speakerNames: string[],
): string {
  if (channel === "dm") {
    return `dm:${speakerNames[0] ?? "counterparty"}`;
  }

  return `${channel}:${speakerNames.sort().join("|")}`;
}

async function ensureSpeakerUser(
  speaker: string,
  targetUserIsTest: boolean,
  assignments: Record<string, ScamBenchSpeakerAssignment>,
  resolvedSpeakerIds: Map<string, string>,
  createMissingSpeakers: boolean,
): Promise<string> {
  const cached = resolvedSpeakerIds.get(speaker);
  if (cached) {
    return cached;
  }

  const assignment = assignments[speaker];
  if (assignment?.userId) {
    resolvedSpeakerIds.set(speaker, assignment.userId);
    return assignment.userId;
  }

  if (!createMissingSpeakers) {
    throw new Error(
      `Missing speaker assignment for "${speaker}". Set createMissingSpeakers or provide speakerAssignments.`,
    );
  }

  const userId = await generateSnowflakeId();
  const now = new Date();
  const speakerSlug = slugifySpeakerName(speaker) || "speaker";
  const suffix = userId.slice(-6).toLowerCase();

  await db.user.create({
    data: {
      id: userId,
      username: assignment?.username || `${speakerSlug}-${suffix}`,
      displayName: assignment?.displayName || speaker,
      isActor: assignment?.isActor ?? true,
      isTest: targetUserIsTest,
      updatedAt: now,
    },
  });

  if (assignment?.isActor ?? true) {
    await db.actorState.create({
      data: {
        id: userId,
        updatedAt: now,
      },
    });
  }

  resolvedSpeakerIds.set(speaker, userId);
  return userId;
}

async function createScenarioGroupChat(options: {
  scenario: ScamBenchSeedScenario;
  stage: ScamBenchSeedStage | null;
  participantIds: string[];
  ownerId: string;
}): Promise<string> {
  const now = new Date();
  const groupId = await generateSnowflakeId();
  const chatId = await generateSnowflakeId();
  const chatName = options.stage
    ? `${options.scenario.name} · ${options.stage.label}`
    : `${options.scenario.name} · Preamble`;

  await db.group.create({
    data: {
      id: groupId,
      name: chatName,
      type: "npc",
      ownerId: options.ownerId,
      createdById: options.ownerId,
      updatedAt: now,
    },
  });

  await db.chat.create({
    data: {
      id: chatId,
      name: chatName,
      isGroup: true,
      groupId,
      gameId: "realtime",
      updatedAt: now,
    },
  });

  for (const participantId of options.participantIds) {
    const role = participantId === options.ownerId ? "owner" : "member";
    await db.groupMember.create({
      data: {
        id: await generateSnowflakeId(),
        groupId,
        userId: participantId,
        role,
        addedBy: options.ownerId,
        isActive: true,
        joinedAt: now,
      },
    });

    await db.chatParticipant.create({
      data: {
        id: await generateSnowflakeId(),
        chatId,
        userId: participantId,
        invitedBy: options.ownerId,
        isActive: true,
        joinedAt: now,
      },
    });
  }

  return chatId;
}

async function resolveSegment(
  options: SeedScamBenchScenarioOptions,
  resolvedSpeakerIds: Map<string, string>,
  segmentMessages: ScamBenchSeedMessage[],
  targetUserIsTest: boolean,
): Promise<ResolvedSegment | null> {
  const inbound = segmentMessages.filter(
    (message) =>
      message.role !== "assistant" &&
      message.role !== "system" &&
      message.content.trim().length > 0,
  );
  if (inbound.length === 0) {
    return null;
  }

  const speakerNames = uniqueStrings(inbound.map((message) => message.speaker));
  if (speakerNames.length === 0) {
    return null;
  }

  for (const speaker of speakerNames) {
    await ensureSpeakerUser(
      speaker,
      targetUserIsTest,
      options.speakerAssignments ?? {},
      resolvedSpeakerIds,
      options.createMissingSpeakers ?? true,
    );
  }

  return {
    channel: inbound[0]?.channel,
    messages: inbound,
    speakerNames,
  };
}

export async function seedScamBenchScenario(
  options: SeedScamBenchScenarioOptions,
): Promise<SeedScamBenchScenarioResult> {
  const [targetUser] = await db.user.findMany({
    where: {
      id: options.targetUserId,
    },
    take: 1,
  });

  if (!targetUser) {
    throw new Error(`Target user ${options.targetUserId} not found`);
  }

  const autoJoinedGroupChats = await autoJoinEmptyUsersToNpcGroupChats({
    enabled: true,
    batchSize: 1,
    targetChatsPerUser: Math.max(1, options.targetChatsPerUser ?? 3),
    defaultMaxMembers: 25,
    userIdAllowlist: [options.targetUserId],
  });

  const resolvedSpeakerIds = new Map<string, string>();
  const chatBySegmentKey = new Map<
    string,
    {
      chatId: string;
      channel: ScamBenchSeedChannel;
      participantIds: string[];
      stageIds: string[];
      reused: boolean;
    }
  >();
  const seededMessages: SeededScamBenchMessage[] = [];

  const preambleGroups = new Map<string, ScamBenchSeedMessage[]>();
  for (const message of options.scenario.preamble ?? []) {
    if (message.role === "assistant" || message.role === "system") continue;
    const key = `preamble:${message.channel}`;
    const existing = preambleGroups.get(key) ?? [];
    existing.push(message);
    preambleGroups.set(key, existing);
  }

  const preambleSegments = [...preambleGroups.values()].map((messages) => ({
    stageId: null as string | null,
    stage: null as ScamBenchSeedStage | null,
    messages,
  }));

  const stageSegments = options.scenario.stages.map((stage) => ({
    stageId: stage.id,
    stage,
    messages: selectStageMessages(options.scenario, stage),
  }));

  for (const segment of [...preambleSegments, ...stageSegments]) {
    const resolved = await resolveSegment(
      options,
      resolvedSpeakerIds,
      segment.messages,
      Boolean(targetUser.isTest),
    );
    if (!resolved) {
      continue;
    }

    const segmentKey = buildSegmentKey(resolved.channel, resolved.speakerNames);
    const speakerIds = resolved.speakerNames.map(
      (speaker) => resolvedSpeakerIds.get(speaker)!,
    );
    const participantIds = uniqueStrings([options.targetUserId, ...speakerIds]);
    let chatState = chatBySegmentKey.get(segmentKey);

    if (!chatState) {
      const ownerId = speakerIds[0] ?? options.targetUserId;
      const chatId = GROUP_LIKE_CHANNELS.has(resolved.channel)
        ? await createScenarioGroupChat({
            scenario: options.scenario,
            stage: segment.stage,
            participantIds,
            ownerId,
          })
        : await getOrCreateDMChat(options.targetUserId, ownerId);

      chatState = {
        chatId,
        channel: resolved.channel,
        participantIds,
        stageIds: [],
        reused: false,
      };
      chatBySegmentKey.set(segmentKey, chatState);
    } else {
      chatState.reused = true;
    }

    if (segment.stageId) {
      chatState.stageIds.push(segment.stageId);
    }

    for (const message of resolved.messages) {
      const senderId = resolvedSpeakerIds.get(message.speaker);
      if (!senderId) continue;
      const messageId = await sendMessageToChat(
        chatState.chatId,
        senderId,
        message.content,
      );
      seededMessages.push({
        messageId,
        chatId: chatState.chatId,
        stageId: segment.stageId,
        channel: resolved.channel,
        speaker: message.speaker,
        senderId,
        content: message.content,
      });
    }

    if (
      GROUP_LIKE_CHANNELS.has(chatState.channel) &&
      options.refreshSharedContext !== false
    ) {
      await sharedChatContextService.refreshChatContext(chatState.chatId);
    }
  }

  const chats: SeededScamBenchChat[] = [...chatBySegmentKey.values()].map(
    (chat) => ({
      chatId: chat.chatId,
      channel: chat.channel,
      participantIds: chat.participantIds,
      stageIds: chat.stageIds,
      reused: chat.reused,
    }),
  );

  logger.info(
    "Seeded ScamBench scenario into Feed chats",
    {
      scenarioId: options.scenario.id,
      targetUserId: options.targetUserId,
      autoJoinedGroupChats,
      chatCount: chats.length,
      messageCount: seededMessages.length,
    },
    "ScamBenchScenarioSeedingService",
  );

  return {
    scenarioId: options.scenario.id,
    targetUserId: options.targetUserId,
    autoJoinedGroupChats,
    speakerUserIds: Object.fromEntries(resolvedSpeakerIds.entries()),
    chats,
    messages: seededMessages,
  };
}
