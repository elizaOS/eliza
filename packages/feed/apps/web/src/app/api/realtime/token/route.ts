import {
  authenticate,
  issueRealtimeToken,
  type RealtimeChannel,
  withErrorHandling,
} from "@feed/api";
import { and, db, eq, inArray, users } from "@feed/db";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isUserInDmChatId } from "../../chats/_lib/dm-chat-id";

const BodySchema = z.object({
  channels: z.array(z.string()).optional(),
  chatIds: z.array(z.string()).optional(),
  agentIds: z.array(z.string()).optional(),
  includeNotifications: z.coerce.boolean().optional(),
  ttlSeconds: z.number().int().positive().max(3600).optional(),
});

const PUBLIC_CHANNELS: RealtimeChannel[] = [
  "feed",
  "markets",
  "breaking-news",
  "upcoming-events",
];

const dedupe = <T>(items: T[]) => Array.from(new Set(items));
export const POST = withErrorHandling(async function POST(
  request: NextRequest,
) {
  const user = await authenticate(request);

  let body: unknown = {};
  const bodyText = await request.text();
  if (bodyText.trim()) {
    body = JSON.parse(bodyText);
  }

  const {
    channels = [],
    chatIds = [],
    agentIds = [],
    includeNotifications = true,
    ttlSeconds,
  } = BodySchema.parse(body);

  const requestedChannels = channels.filter(Boolean) as RealtimeChannel[];
  const baseChannels = [...PUBLIC_CHANNELS];

  if (includeNotifications) {
    baseChannels.push(`notifications:${user.userId}`);
  }

  const derivedChatIds = dedupe([
    ...chatIds,
    ...requestedChannels
      .filter((ch) => ch.startsWith("chat:"))
      .map((ch) => ch.replace("chat:", "")),
  ]).filter(Boolean);

  // Extract agent IDs from requested channels and explicit agentIds param
  const derivedAgentIds = dedupe([
    ...agentIds,
    ...requestedChannels
      .filter((ch) => ch.startsWith("agent:"))
      .map((ch) => ch.replace("agent:", "")),
  ]).filter(Boolean);

  // Determine which chats are authorized for this user.
  const allowedChatIds = new Set<string>();

  if (derivedChatIds.length > 0) {
    const allowedChats = await db.chatParticipant.findMany({
      where: { userId: user.userId, chatId: { in: derivedChatIds } },
      select: { chatId: true },
    });
    allowedChats.forEach((c) => allowedChatIds.add(c.chatId));
  }

  // Allow deterministic DM channels even if the chat row/participants are not yet created.
  for (const chId of derivedChatIds) {
    if (isUserInDmChatId(chId, user.userId)) {
      allowedChatIds.add(chId);
    }
  }

  const unauthorizedChats = derivedChatIds.filter(
    (id) => !allowedChatIds.has(id),
  );
  if (unauthorizedChats.length > 0) {
    logger.warn(
      "Realtime token: unauthorized chat channels requested",
      { userId: user.userId, unauthorizedChats },
      "Realtime",
    );
    return NextResponse.json(
      { error: "Unauthorized chat channels", unauthorizedChats },
      { status: 403 },
    );
  }

  const chatChannels: RealtimeChannel[] = Array.from(allowedChatIds).map(
    (id) => `chat:${id}` as RealtimeChannel,
  );

  // Determine which agent channels are authorized for this user.
  // User can only subscribe to agents they own (managedBy = userId).
  const allowedAgentIds = new Set<string>();

  if (derivedAgentIds.length > 0) {
    // Single query: fetch agents that match requested IDs AND are owned by this user
    const ownedAgents = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          inArray(users.id, derivedAgentIds),
          eq(users.managedBy, user.userId),
          eq(users.isAgent, true),
        ),
      );

    for (const agent of ownedAgents) {
      allowedAgentIds.add(agent.id);
    }
  }

  // Authorization asymmetry: Agent channels are silently excluded when unauthorized,
  // while chat channels return 403. Rationale:
  // - Chat channels contain private messages; failed auth should be visible to caller
  // - Agent activity is lower priority; silently excluding prevents UX disruption
  //   when e.g., a stale agent ID is in the request but other channels are valid
  // - Client can check isConnected status to detect missing subscriptions
  const unauthorizedAgents = derivedAgentIds.filter(
    (id) => !allowedAgentIds.has(id),
  );
  if (unauthorizedAgents.length > 0) {
    logger.warn(
      "Realtime token: unauthorized agent channels excluded",
      { userId: user.userId, unauthorizedAgents },
      "Realtime",
    );
  }

  const agentChannels: RealtimeChannel[] = Array.from(allowedAgentIds).map(
    (id) => `agent:${id}` as RealtimeChannel,
  );

  // Only allow explicitly known public channels from the request
  const requestedPublic = requestedChannels.filter((ch) =>
    PUBLIC_CHANNELS.includes(ch),
  );

  const finalChannels = dedupe([
    ...baseChannels,
    ...requestedPublic,
    ...chatChannels,
    ...agentChannels,
  ]);

  if (finalChannels.length === 0) {
    return NextResponse.json(
      { error: "No channels authorized" },
      { status: 403 },
    );
  }

  const token = issueRealtimeToken({
    userId: user.userId,
    channels: finalChannels,
    ttlSeconds: ttlSeconds ?? 900,
  });

  const expiresAt = Date.now() + (ttlSeconds ?? 900) * 1000;

  logger.info(
    "Issued realtime token",
    { userId: user.userId, channels: finalChannels },
    "Realtime",
  );

  return NextResponse.json({
    token,
    channels: finalChannels,
    expiresAt,
  });
});
