/**
 * Shared Chat Context Service
 *
 * Maintains low-cost, globally shared summaries and facts extracted from
 * Feed group chats. The goal is to preserve useful cross-chat context
 * without dumping long raw histories into agent prompts.
 */

import {
  and,
  chats,
  count,
  db,
  desc,
  eq,
  groupMembers,
  inArray,
  messages,
  users,
  worldFacts,
} from '@feed/db';
import { generateSnowflakeId, logger } from '@feed/shared';
import { GroupChatService } from './group-chat-service';

const SHARED_CHAT_CONTEXT_CATEGORY = 'shared_chat_context';
const SHARED_CHAT_CONTEXT_SOURCE = 'shared-chat-context';
const DEFAULT_MESSAGE_WINDOW = 10;
const DEFAULT_CHAT_LIMIT = 10;
const DEFAULT_FACT_LIMIT = 12;
const DEFAULT_STALE_MINUTES = 30;
const DEFAULT_REFRESH_THRESHOLD = 10;

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'and',
  'any',
  'are',
  'because',
  'been',
  'being',
  'between',
  'can',
  'could',
  'docs',
  'finish',
  'from',
  'hey',
  'have',
  'having',
  'here',
  'into',
  'just',
  'like',
  'made',
  'make',
  'more',
  'most',
  'not',
  'only',
  'other',
  'over',
  'please',
  'really',
  'review',
  'said',
  'should',
  'some',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'team',
  'time',
  'very',
  'use',
  'want',
  'with',
  'would',
  'your',
  'you',
]);

export interface SharedChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  createdAt: Date;
}

export interface SharedChatContextSnapshot {
  chatId: string;
  chatName: string | null;
  summary: string;
  facts: string[];
  participantNames: string[];
  messageCount: number;
  lastMessageAt: string;
  refreshedAt: string;
}

export interface RelevantGroupContext {
  chatId: string;
  chatName: string | null;
  summary: string;
  facts: string[];
  participantNames: string[];
  messageCount: number;
  lastMessageAt: string;
  refreshedAt: string;
  recentMessages: Array<{
    speaker: string;
    content: string;
    createdAt: string;
  }>;
}

export interface LivePlayerRosterEntry {
  id: string;
  username: string | null;
  displayName: string | null;
  isAgent: boolean;
  activeGroupChatCount: number;
  updatedAt: string;
}

export interface RefreshSharedChatContextOptions {
  messageWindowSize?: number;
  factLimit?: number;
  staleAfterMinutes?: number;
  refreshThreshold?: number;
}

function truncateText(text: string, maxLength: number): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
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

function extractKeywords(texts: string[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const textWithoutUrls = text.replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
    for (const rawWord of textWithoutUrls
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) {
      if (STOP_WORDS.has(rawWord)) continue;
      if (/^\d+$/.test(rawWord)) continue;
      if (rawWord.length < 4 && !/^[a-z0-9]+$/.test(rawWord)) continue;
      counts.set(rawWord, (counts.get(rawWord) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort(
      (a, b) =>
        b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0])
    )
    .slice(0, limit)
    .map(([word]) => word);
}

function buildSummary(
  chatName: string | null,
  messages: SharedChatMessage[],
  keywords: string[]
): string {
  const participants = uniqueStrings(
    messages.map((message) => message.senderName)
  );
  const sortedMessages = [...messages].sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime()
  );
  const latestMessage = sortedMessages[sortedMessages.length - 1];
  const topicText =
    keywords.length > 0 ? keywords.join(', ') : 'ongoing coordination';
  const participantText =
    participants.length > 0 ? participants.join(', ') : 'multiple participants';
  const latestText = latestMessage
    ? truncateText(latestMessage.content, 160)
    : 'No recent messages';
  const heading = chatName ? `${chatName}` : 'Group chat';

  return `${heading}: ${participantText} discussed ${topicText}. Latest: ${latestText}`;
}

function extractFacts(
  messages: SharedChatMessage[],
  keywords: string[],
  factLimit: number
): string[] {
  const facts = new Set<string>();

  if (keywords.length > 0) {
    facts.add(`Topic keywords: ${keywords.join(', ')}`);
  }

  const secretRequestPattern =
    /\b(secret(?:\s+key)?|private key|api key|access key|auth token|password|passphrase|seed phrase|recovery phrase|wallet seed|2fa|otp|verification code|code)\b/i;
  const askPattern =
    /\b(send|share|paste|provide|give|drop|post|upload|DM|message)\b/i;
  const trustPattern =
    /\b(friend|bro|buddy|support|helpdesk|official|security|verification|compliance|account)\b/i;
  const linkPattern = /(https?:\/\/[^\s]+|www\.[^\s]+)/i;
  const codePattern = /\b\d{5,8}\b/;

  for (const message of messages) {
    const text = message.content.trim().replace(/\s+/g, ' ');
    if (!text) continue;

    const speaker = message.senderName || 'Unknown';
    const truncated = truncateText(text, 160);

    if (linkPattern.test(text)) {
      const link = text.match(linkPattern)?.[0];
      if (link) {
        facts.add(`Shared link from ${speaker}: ${link}`);
      }
    }

    if (secretRequestPattern.test(text) && askPattern.test(text)) {
      facts.add(
        `Possible credential or secret request from ${speaker}: ${truncated}`
      );
    }

    if (trustPattern.test(text) && askPattern.test(text)) {
      facts.add(`Trust-building request from ${speaker}: ${truncated}`);
    }

    if (
      codePattern.test(text) &&
      /code|verify|verification|login|auth/i.test(text)
    ) {
      facts.add(
        `Verification / login code mentioned by ${speaker}: ${truncated}`
      );
    }

    if (text.includes('?')) {
      facts.add(`Open question from ${speaker}: ${truncated}`);
    }
  }

  for (const message of [...messages].sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime()
  )) {
    if (facts.size >= factLimit) break;
    facts.add(
      `Notable statement from ${message.senderName}: ${truncateText(message.content, 120)}`
    );
  }

  return [...facts].slice(0, factLimit);
}

function parseStoredSnapshot(
  value: string | null
): SharedChatContextSnapshot | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<SharedChatContextSnapshot>;
    if (
      !parsed ||
      typeof parsed.chatId !== 'string' ||
      typeof parsed.summary !== 'string'
    ) {
      return null;
    }

    return {
      chatId: parsed.chatId,
      chatName:
        typeof parsed.chatName === 'string' || parsed.chatName === null
          ? parsed.chatName
          : null,
      summary: parsed.summary,
      facts: Array.isArray(parsed.facts)
        ? parsed.facts.filter(
            (fact): fact is string => typeof fact === 'string'
          )
        : [],
      participantNames: Array.isArray(parsed.participantNames)
        ? parsed.participantNames.filter(
            (participant): participant is string =>
              typeof participant === 'string'
          )
        : [],
      messageCount: Number(parsed.messageCount ?? 0),
      lastMessageAt:
        typeof parsed.lastMessageAt === 'string'
          ? parsed.lastMessageAt
          : new Date().toISOString(),
      refreshedAt:
        typeof parsed.refreshedAt === 'string'
          ? parsed.refreshedAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export class SharedChatContextService {
  private getSnapshotKey(chatId: string): string {
    return `chat:${chatId}`;
  }

  private async getSummaryRow(chatId: string) {
    const [row] = await db
      .select()
      .from(worldFacts)
      .where(
        and(
          eq(worldFacts.category, SHARED_CHAT_CONTEXT_CATEGORY),
          eq(worldFacts.key, this.getSnapshotKey(chatId))
        )
      )
      .limit(1);
    return row ?? null;
  }

  private async getLatestMessageMeta(chatId: string): Promise<{
    lastMessageAt: Date | null;
    messageCount: number;
  }> {
    const [latest] = await db
      .select({ createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.createdAt))
      .limit(1);

    const [countRow] = await db
      .select({ count: count() })
      .from(messages)
      .where(eq(messages.chatId, chatId));

    return {
      lastMessageAt: latest?.createdAt ?? null,
      messageCount: Number(countRow?.count ?? 0),
    };
  }

  private async getRecentMessages(
    chatId: string,
    messageWindowSize: number
  ): Promise<SharedChatMessage[]> {
    const rows = await db
      .select({
        id: messages.id,
        senderId: messages.senderId,
        senderName: users.displayName,
        senderUsername: users.username,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(users, eq(messages.senderId, users.id))
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.createdAt))
      .limit(messageWindowSize);

    return rows
      .map((row) => ({
        id: row.id,
        senderId: row.senderId,
        senderName:
          row.senderName || row.senderUsername || row.senderId.slice(-6),
        content: row.content,
        createdAt: row.createdAt,
      }))
      .reverse();
  }

  private async getChatName(chatId: string): Promise<string | null> {
    const [row] = await db
      .select({
        chatName: chats.name,
      })
      .from(chats)
      .where(eq(chats.id, chatId))
      .limit(1);

    return row?.chatName ?? null;
  }

  private async upsertSnapshot(
    snapshot: SharedChatContextSnapshot
  ): Promise<void> {
    const existing = await this.getSummaryRow(snapshot.chatId);

    if (existing) {
      await db
        .update(worldFacts)
        .set({
          category: SHARED_CHAT_CONTEXT_CATEGORY,
          key: this.getSnapshotKey(snapshot.chatId),
          label: snapshot.chatName || `Chat ${snapshot.chatId}`,
          value: JSON.stringify(snapshot),
          source: SHARED_CHAT_CONTEXT_SOURCE,
          priority: Math.min(100, Math.max(0, snapshot.facts.length + 5)),
          lastUpdated: new Date(),
          isActive: true,
          updatedAt: new Date(),
        })
        .where(eq(worldFacts.id, existing.id));
      return;
    }

    await db.insert(worldFacts).values({
      id: await generateSnowflakeId(),
      category: SHARED_CHAT_CONTEXT_CATEGORY,
      key: this.getSnapshotKey(snapshot.chatId),
      label: snapshot.chatName || `Chat ${snapshot.chatId}`,
      value: JSON.stringify(snapshot),
      source: SHARED_CHAT_CONTEXT_SOURCE,
      priority: Math.min(100, Math.max(0, snapshot.facts.length + 5)),
      lastUpdated: new Date(),
      isActive: true,
      updatedAt: new Date(),
    });
  }

  async getStoredSnapshot(
    chatId: string
  ): Promise<SharedChatContextSnapshot | null> {
    const row = await this.getSummaryRow(chatId);
    return parseStoredSnapshot(row?.value ?? null);
  }

  async refreshChatContext(
    chatId: string,
    options: RefreshSharedChatContextOptions = {}
  ): Promise<SharedChatContextSnapshot | null> {
    try {
      const messageWindowSize = Math.max(
        3,
        options.messageWindowSize ?? DEFAULT_MESSAGE_WINDOW
      );
      const factLimit = Math.max(1, options.factLimit ?? DEFAULT_FACT_LIMIT);
      const recentMessages = await this.getRecentMessages(
        chatId,
        messageWindowSize
      );

      if (recentMessages.length === 0) {
        return null;
      }

      const chatName = await this.getChatName(chatId);
      const keywords = extractKeywords(
        recentMessages.map((message) => message.content),
        5
      );
      const summary = buildSummary(chatName, recentMessages, keywords);
      const facts = extractFacts(recentMessages, keywords, factLimit);
      const participantNames = uniqueStrings(
        recentMessages.map((message) => message.senderName)
      );
      const latestMessage = recentMessages[recentMessages.length - 1];
      const { messageCount } = await this.getLatestMessageMeta(chatId);

      const snapshot: SharedChatContextSnapshot = {
        chatId,
        chatName,
        summary,
        facts,
        participantNames,
        messageCount,
        lastMessageAt: latestMessage
          ? latestMessage.createdAt.toISOString()
          : new Date().toISOString(),
        refreshedAt: new Date().toISOString(),
      };

      await this.upsertSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      logger.warn(
        'Failed to refresh shared chat context',
        {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        },
        'SharedChatContextService'
      );
      return null;
    }
  }

  async maybeRefreshChatContext(
    chatId: string,
    options: RefreshSharedChatContextOptions = {}
  ): Promise<SharedChatContextSnapshot | null> {
    const staleAfterMinutes =
      options.staleAfterMinutes ?? DEFAULT_STALE_MINUTES;
    const refreshThreshold =
      options.refreshThreshold ?? DEFAULT_REFRESH_THRESHOLD;
    const stored = await this.getStoredSnapshot(chatId);
    const latest = await this.getLatestMessageMeta(chatId);

    if (!latest.lastMessageAt) {
      return stored;
    }

    if (!stored) {
      return this.refreshChatContext(chatId, options);
    }

    const storedLastMessageAt = new Date(stored.lastMessageAt).getTime();
    const storedRefreshedAt = new Date(stored.refreshedAt).getTime();
    const latestMessageTime = latest.lastMessageAt.getTime();
    const staleWindowMs = Math.max(1, staleAfterMinutes) * 60_000;
    const isStale = Date.now() - storedRefreshedAt >= staleWindowMs;
    const hasNewMessages = latestMessageTime > storedLastMessageAt;
    const messagesSinceRefresh = latest.messageCount - stored.messageCount;

    if (
      isStale ||
      (hasNewMessages && messagesSinceRefresh >= refreshThreshold)
    ) {
      return this.refreshChatContext(chatId, options);
    }

    return stored;
  }

  async getSharedFacts(options: { limit?: number } = {}): Promise<
    Array<{
      chatId: string;
      chatName: string | null;
      fact: string;
      refreshedAt: string;
      lastMessageAt: string;
    }>
  > {
    const limit = Math.max(1, options.limit ?? DEFAULT_FACT_LIMIT);
    const rows = await db
      .select()
      .from(worldFacts)
      .where(
        and(
          eq(worldFacts.category, SHARED_CHAT_CONTEXT_CATEGORY),
          eq(worldFacts.source, SHARED_CHAT_CONTEXT_SOURCE),
          eq(worldFacts.isActive, true)
        )
      )
      .orderBy(desc(worldFacts.updatedAt))
      .limit(100);

    const facts: Array<{
      chatId: string;
      chatName: string | null;
      fact: string;
      refreshedAt: string;
      lastMessageAt: string;
    }> = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const snapshot = parseStoredSnapshot(row.value);
      if (!snapshot) continue;

      for (const fact of snapshot.facts) {
        const key = `${snapshot.chatId}:${fact}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({
          chatId: snapshot.chatId,
          chatName: snapshot.chatName,
          fact,
          refreshedAt: snapshot.refreshedAt,
          lastMessageAt: snapshot.lastMessageAt,
        });
        if (facts.length >= limit) {
          return facts;
        }
      }
    }

    return facts;
  }

  async getRelevantGroupContextForUser(
    userId: string,
    options: {
      chatLimit?: number;
      messageWindowSize?: number;
      factLimit?: number;
      staleAfterMinutes?: number;
      refreshThreshold?: number;
    } = {}
  ): Promise<RelevantGroupContext[]> {
    const chatLimit = Math.max(1, options.chatLimit ?? DEFAULT_CHAT_LIMIT);
    const messageWindowSize = Math.max(
      3,
      options.messageWindowSize ?? DEFAULT_MESSAGE_WINDOW
    );

    const memberships = await GroupChatService.getUserGroupChats(userId);
    if (memberships.length === 0) {
      return [];
    }

    const snapshots: Array<{
      chatId: string;
      chatName: string | null;
      summary: string;
      facts: string[];
      participantNames: string[];
      messageCount: number;
      lastMessageAt: string;
      refreshedAt: string;
    }> = [];

    for (const chat of memberships) {
      const snapshot =
        (await this.maybeRefreshChatContext(chat.id, options)) ??
        (await this.getStoredSnapshot(chat.id));
      if (!snapshot) continue;

      snapshots.push({
        chatId: snapshot.chatId,
        chatName: snapshot.chatName,
        summary: snapshot.summary,
        facts: snapshot.facts,
        participantNames: snapshot.participantNames,
        messageCount: snapshot.messageCount,
        lastMessageAt: snapshot.lastMessageAt,
        refreshedAt: snapshot.refreshedAt,
      });
    }

    const orderedSnapshots = snapshots
      .sort(
        (left, right) =>
          new Date(right.lastMessageAt).getTime() -
          new Date(left.lastMessageAt).getTime()
      )
      .slice(0, chatLimit);

    return Promise.all(
      orderedSnapshots.map(async (snapshot) => {
        const recentMessages = await this.getRecentMessages(
          snapshot.chatId,
          messageWindowSize
        );

        return {
          ...snapshot,
          recentMessages: recentMessages.map((message) => ({
            speaker: message.senderName,
            content: message.content,
            createdAt: message.createdAt.toISOString(),
          })),
        };
      })
    );
  }

  async getLivePlayerRoster(
    options: { limit?: number } = {}
  ): Promise<LivePlayerRosterEntry[]> {
    const limit = Math.max(1, options.limit ?? 50);
    const players = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        isAgent: users.isAgent,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(and(eq(users.isActor, false), eq(users.isBanned, false)))
      .orderBy(desc(users.updatedAt))
      .limit(limit);

    if (players.length === 0) {
      return [];
    }

    const playerIds = players.map((player) => player.id);
    const membershipCounts = await db
      .select({
        userId: groupMembers.userId,
        activeGroupChatCount: count(),
      })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.isActive, true),
          inArray(groupMembers.userId, playerIds)
        )
      )
      .groupBy(groupMembers.userId);

    const countMap = new Map(
      membershipCounts.map((row) => [
        row.userId,
        Number(row.activeGroupChatCount),
      ])
    );

    return players.map((player) => ({
      id: player.id,
      username: player.username,
      displayName: player.displayName,
      isAgent: player.isAgent,
      activeGroupChatCount: countMap.get(player.id) ?? 0,
      updatedAt: player.updatedAt.toISOString(),
    }));
  }
}

export const sharedChatContextService = new SharedChatContextService();

export {
  buildSummary,
  extractFacts,
  extractKeywords,
  parseStoredSnapshot,
  truncateText,
};
