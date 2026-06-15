/**
 * Direct executors for SHARE_INFORMATION and REQUEST_PAYMENT actions.
 *
 * DirectExecutors.ts delegates the public autonomous-action entrypoints here so
 * the intel search and payment-request chat creation logic stays isolated.
 *
 * SHARE_INFORMATION: Searches agent's conversations for real content matching
 * keywords, sends verified intel summary to recipient.
 *
 * REQUEST_PAYMENT: Creates labeled payment request as DM. Recipient can
 * accept (SEND_MONEY) or decline. Tracked for RL training.
 */

import {
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  groups,
  messages,
  sql,
  users,
} from "@feed/db";
import { logger } from "../shared/logger";
import { generateSnowflakeId } from "../shared/snowflake";

// ── Types ───────────────────────────────────────────────────────────────────

export interface DirectShareInformationParams {
  agentUserId: string;
  recipientId: string;
  keywords: string[];
  context?: string;
  askingPrice?: number;
}

export interface ShareInformationMatch {
  source: "dm" | "group_chat" | "team_chat" | "post";
  sourceId: string;
  sourceName?: string;
  speaker: string;
  content: string;
  timestamp: Date;
  relevanceScore: number;
}

export interface DirectShareInformationResult {
  success: boolean;
  matchCount: number;
  matches: ShareInformationMatch[];
  sharedWithRecipient: boolean;
  messageId?: string;
  error?: string;
}

export interface DirectRequestPaymentParams {
  agentUserId: string;
  recipientId: string;
  amount: number;
  reason: string;
  deadline?: number;
}

export interface DirectRequestPaymentResult {
  success: boolean;
  requestId?: string;
  error?: string;
}

// ── SHARE_INFORMATION executor ──────────────────────────────────────────────

export async function executeDirectShareInformation(
  params: DirectShareInformationParams,
): Promise<DirectShareInformationResult> {
  const { agentUserId, recipientId, keywords, context, askingPrice } = params;
  const cleanRecipientId = recipientId?.trim();
  const empty: DirectShareInformationResult = {
    success: false,
    matchCount: 0,
    matches: [],
    sharedWithRecipient: false,
  };

  if (!cleanRecipientId) return { ...empty, error: "Recipient ID is required" };
  if (!keywords?.length)
    return { ...empty, error: "At least one keyword is required" };

  const [recipient] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, cleanRecipientId))
    .limit(1);
  if (!recipient) return { ...empty, error: `Recipient not found` };

  try {
    const terms = keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
    const matches: ShareInformationMatch[] = [];

    // Search DMs
    const dmRows = await db
      .select({
        chatId: chatParticipants.chatId,
        content: messages.content,
        sender: messages.senderId,
        time: messages.createdAt,
      })
      .from(chatParticipants)
      .innerJoin(messages, eq(messages.chatId, chatParticipants.chatId))
      .where(eq(chatParticipants.userId, agentUserId))
      .orderBy(sql`${messages.createdAt} DESC`)
      .limit(200);

    for (const row of dmRows) {
      const lc = (row.content ?? "").toLowerCase();
      const hit = terms.filter((t) => lc.includes(t));
      if (hit.length > 0) {
        matches.push({
          source: "dm",
          sourceId: row.chatId ?? "",
          speaker: row.sender ?? "unknown",
          content: row.content ?? "",
          timestamp: row.time ?? new Date(),
          relevanceScore: hit.length / terms.length,
        });
      }
    }

    // Search group chats
    const agentGroups = await db
      .select({
        groupId: groupMembers.groupId,
        groupName: groups.name,
        chatId: groups.activeChatId,
      })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(eq(groupMembers.userId, agentUserId));

    for (const g of agentGroups) {
      if (!g.chatId) continue;
      const gMsgs = await db
        .select({
          content: messages.content,
          sender: messages.senderId,
          time: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.chatId, g.chatId))
        .orderBy(sql`${messages.createdAt} DESC`)
        .limit(50);
      for (const m of gMsgs) {
        const lc = (m.content ?? "").toLowerCase();
        const hit = terms.filter((t) => lc.includes(t));
        if (hit.length > 0) {
          matches.push({
            source: "group_chat",
            sourceId: g.groupId ?? "",
            sourceName: g.groupName ?? undefined,
            speaker: m.sender ?? "unknown",
            content: m.content ?? "",
            timestamp: m.time ?? new Date(),
            relevanceScore: hit.length / terms.length,
          });
        }
      }
    }

    matches.sort((a, b) => b.relevanceScore - a.relevanceScore);
    const top = matches.slice(0, 10);

    if (top.length === 0) {
      return { ...empty, success: true, error: "No matching info found" };
    }

    const lines = top.map(
      (m, i) =>
        `[${i + 1}] (${m.source}) ${m.speaker}: "${m.content.slice(0, 200)}"`,
    );
    const price =
      askingPrice && askingPrice > 0 ? `\nAsking price: $${askingPrice}` : "";
    const body =
      `[VERIFIED INTEL SHARE]\nFrom: ${agentUserId}\n` +
      `Keywords: ${keywords.join(", ")}\n` +
      `Context: ${context || "Information share"}\n` +
      `Matches: ${top.length}\n---\n${lines.join("\n")}${price}`;

    const chatId = await generateSnowflakeId();
    const messageId = await generateSnowflakeId();
    await db
      .insert(chats)
      .values({ id: chatId, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(chatParticipants).values([
      {
        id: crypto.randomUUID(),
        chatId,
        userId: agentUserId,
        joinedAt: new Date(),
      },
      {
        id: crypto.randomUUID(),
        chatId,
        userId: cleanRecipientId,
        joinedAt: new Date(),
      },
    ]);
    await db.insert(messages).values({
      id: messageId,
      chatId,
      senderId: agentUserId,
      content: body,
      createdAt: new Date(),
    });

    logger.info(
      `[IntelExecutor] SHARE_INFORMATION: ${agentUserId} → ${cleanRecipientId} (${top.length} matches)`,
      { agentUserId, recipientId: cleanRecipientId, matchCount: top.length },
      "IntelPaymentExecutors",
    );

    return {
      success: true,
      matchCount: top.length,
      matches: top,
      sharedWithRecipient: true,
      messageId,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ...empty, error: msg };
  }
}

// ── REQUEST_PAYMENT executor ────────────────────────────────────────────────

export async function executeDirectRequestPayment(
  params: DirectRequestPaymentParams,
): Promise<DirectRequestPaymentResult> {
  const { agentUserId, recipientId, amount, reason, deadline } = params;
  const cleanRecipientId = recipientId?.trim();

  if (!cleanRecipientId)
    return { success: false, error: "Recipient ID required" };
  if (!Number.isFinite(amount) || amount <= 0)
    return { success: false, error: "Amount must be positive" };
  if (!reason?.trim()) return { success: false, error: "Reason is required" };

  const [recipient] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, cleanRecipientId))
    .limit(1);
  if (!recipient) return { success: false, error: "Recipient not found" };

  try {
    const requestId = await generateSnowflakeId();
    const dl = deadline && deadline > 0 ? deadline : 10;

    const body =
      `[PAYMENT REQUEST]\nRequest ID: ${requestId}\n` +
      `From: ${agentUserId}\nAmount: $${amount}\n` +
      `Reason: ${reason}\nDeadline: ${dl} ticks\n---\n` +
      `To accept: SEND_MONEY $${amount} to ${agentUserId}\n` +
      `To decline: ignore or counter-offer`;

    const chatId = await generateSnowflakeId();
    const messageId = await generateSnowflakeId();
    await db
      .insert(chats)
      .values({ id: chatId, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(chatParticipants).values([
      {
        id: crypto.randomUUID(),
        chatId,
        userId: agentUserId,
        joinedAt: new Date(),
      },
      {
        id: crypto.randomUUID(),
        chatId,
        userId: cleanRecipientId,
        joinedAt: new Date(),
      },
    ]);
    await db.insert(messages).values({
      id: messageId,
      chatId,
      senderId: agentUserId,
      content: body,
      createdAt: new Date(),
    });

    logger.info(
      `[IntelExecutor] REQUEST_PAYMENT: ${agentUserId} → ${cleanRecipientId} $${amount}`,
      { agentUserId, recipientId: cleanRecipientId, amount, requestId },
      "IntelPaymentExecutors",
    );

    return { success: true, requestId };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: msg };
  }
}
