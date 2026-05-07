import { DEFAULT_MARKUP_RATE, type MarkupBreakdown } from "@elizaos/billing";
import {
  type SendTweetV2Params,
  type TTweetv2Expansion,
  type TTweetv2TweetField,
  type TTweetv2UserField,
  type TweetV2,
  TwitterApi,
  type UserV2,
} from "twitter-api-v2";
import { servicePricingRepository } from "@/db/repositories/service-pricing";
import { creditsService } from "@/lib/services/credits";
import type { OAuthConnectionRole } from "@/lib/services/oauth/types";
import { twitterAutomationService } from "@/lib/services/twitter-automation";
import { logger } from "@/lib/utils/logger";

export type XOperation = "status" | "post" | "dm.send" | "dm.digest" | "dm.curate" | "feed.read";

export interface XOperationCostMetadata extends MarkupBreakdown {
  operation: XOperation;
  service: "x";
}

export interface XAuthenticatedUser {
  id: string;
  username: string;
  name: string;
  description: string | null;
  profileImageUrl: string | null;
  verified: boolean | null;
  publicMetrics: UserV2["public_metrics"] | null;
}

export interface XDirectMessage {
  id: string;
  text: string;
  createdAt: string | null;
  conversationId: string;
  participantIds: string[];
  senderId: string;
  recipientId: string;
  participantId: string;
  direction: "sent" | "received";
  entities: XDirectMessageEntities | null;
  hasAttachment: boolean;
}

export type XFeedType = "home_timeline" | "mentions" | "search";

export interface XFeedItem {
  id: string;
  text: string;
  createdAt: string | null;
  authorId: string;
  authorHandle: string;
  conversationId: string | null;
  referencedTweets: Array<{ type: string; id: string }>;
  publicMetrics: TweetV2["public_metrics"] | null;
  entities: TweetV2["entities"] | null;
}

export interface XDmCurationItem {
  message: XDirectMessage;
  curationScore: number;
  priority: "high" | "medium" | "low";
  recommendedAction: "reply" | "review" | "archive";
  reason: string;
}

export class XServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "XServiceError";
  }
}

type XCloudCredentials =
  | {
      authMode: "oauth1a";
      appKey: string;
      appSecret: string;
      accessToken: string;
      accessSecret: string;
    }
  | {
      authMode: "oauth2";
      accessToken: string;
    };

type XClient = InstanceType<typeof TwitterApi>;

type XDirectMessageEntities = {
  urls?: Array<Record<string, unknown>>;
  hashtags?: Array<Record<string, unknown>>;
  cashtags?: Array<Record<string, unknown>>;
  mentions?: Array<Record<string, unknown>>;
};

type XDirectMessageEventV2 = {
  id: string;
  event_type: "MessageCreate" | "ParticipantsJoin" | "ParticipantsLeave";
  text?: string;
  created_at?: string;
  sender_id?: string;
  dm_conversation_id?: string;
  attachments?: {
    media_keys?: string[];
    card_ids?: string[];
  };
  participant_ids?: string[];
  entities?: XDirectMessageEntities;
};

type XDirectMessageTimelineV2 = {
  events: XDirectMessageEventV2[];
};

type XApiErrorData = {
  error?: string;
  detail?: string;
  title?: string;
  status?: number;
  errors?: Array<{
    detail?: string;
    message?: string;
    title?: string;
    errors?: Array<{
      message?: string;
    }>;
  }>;
};

type XApiError = Error & {
  code?: number;
  data?: XApiErrorData;
  rateLimit?: {
    remaining?: number;
    reset?: number;
  };
};

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function applyXMarkup(cost: number, markupRate = DEFAULT_MARKUP_RATE): MarkupBreakdown {
  const rawCost = roundUsd(cost);
  const billedCost = roundUsd(rawCost * (1 + markupRate));
  return {
    rawCost,
    markup: roundUsd(billedCost - rawCost),
    billedCost,
    markupRate,
  };
}

const X_USER_FIELDS: TTweetv2UserField[] = [
  "description",
  "profile_image_url",
  "public_metrics",
  "verified",
];

const X_FEED_TWEET_FIELDS: TTweetv2TweetField[] = [
  "id",
  "text",
  "author_id",
  "created_at",
  "conversation_id",
  "referenced_tweets",
  "public_metrics",
  "entities",
];

const X_FEED_EXPANSIONS: TTweetv2Expansion[] = ["author_id"];

const X_FEED_USER_FIELDS: TTweetv2UserField[] = [
  "username",
  "name",
  "profile_image_url",
  "verified",
];

const MAX_TWEET_LENGTH = 280;
const MAX_DM_LENGTH = 10_000;
const DEFAULT_DM_LIMIT = 20;
const MAX_DM_LIMIT = 50;
const DEFAULT_FEED_LIMIT = 20;
const MAX_FEED_LIMIT = 50;

function fail(status: number, message: string): never {
  throw new XServiceError(status, message);
}

function normalizeText(value: string, fieldName: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    fail(400, `${fieldName} is required`);
  }
  if (trimmed.length > maxLength) {
    fail(400, `${fieldName} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}

function normalizeSnowflake(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    fail(400, `${fieldName} must be a numeric X user id`);
  }
  return trimmed;
}

function normalizeDmLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DM_LIMIT;
  if (!Number.isInteger(value) || value <= 0) {
    fail(400, "maxResults must be a positive integer");
  }
  return Math.min(value, MAX_DM_LIMIT);
}

function normalizeFeedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FEED_LIMIT;
  if (!Number.isInteger(value) || value <= 0) {
    fail(400, "maxResults must be a positive integer");
  }
  return Math.min(value, MAX_FEED_LIMIT);
}

function normalizeFeedType(value: string | undefined): XFeedType {
  if (value === "home_timeline" || value === "mentions" || value === "search") {
    return value;
  }
  fail(400, "feedType must be one of home_timeline, mentions, or search");
}

function normalizeConnectionRole(role?: OAuthConnectionRole): OAuthConnectionRole {
  return role === "agent" ? "agent" : "owner";
}

function normalizeParticipantIds(value: string[]): string[] {
  const ids = value.map((participantId, index) =>
    normalizeSnowflake(participantId, `participantIds[${index}]`),
  );
  const unique = [...new Set(ids)];
  if (unique.length < 2) {
    fail(400, "A group X DM requires at least two participant IDs");
  }
  return unique;
}

async function resolveXOperationCost(operation: XOperation): Promise<XOperationCostMetadata> {
  const pricing = await servicePricingRepository.findByServiceAndMethod("x", operation);
  if (!pricing) {
    throw new XServiceError(503, `X pricing is not configured for operation ${operation}`);
  }

  const rawCost = Number(pricing.cost);
  if (!Number.isFinite(rawCost) || rawCost < 0) {
    throw new XServiceError(503, `Invalid X pricing for operation ${operation}`);
  }

  const breakdown = applyXMarkup(rawCost);
  return {
    operation,
    service: "x",
    ...breakdown,
  };
}

function formatUsd(amount: number): string {
  return amount < 0.01 ? amount.toFixed(6) : amount.toFixed(2);
}

function xBillingMetadata(cost: XOperationCostMetadata): Record<string, unknown> {
  return {
    type: `x_${cost.operation}`,
    service: cost.service,
    operation: cost.operation,
    rawCost: cost.rawCost,
    markup: cost.markup,
    billedCost: cost.billedCost,
    markupRate: cost.markupRate,
  };
}

async function chargeXOperation(
  organizationId: string,
  cost: XOperationCostMetadata,
): Promise<{
  refund: (reason: string) => Promise<void>;
}> {
  if (cost.billedCost <= 0) {
    return { refund: async () => {} };
  }

  const result = await creditsService.reserveAndDeductCredits({
    organizationId,
    amount: cost.billedCost,
    description: `X API ${cost.operation}`,
    metadata: xBillingMetadata(cost),
  });

  if (!result.success) {
    if (result.reason === "org_not_found") {
      fail(404, "Organization not found");
    }
    fail(
      402,
      `Insufficient credits for X ${cost.operation}. Required: $${formatUsd(cost.billedCost)}.`,
    );
  }

  return {
    refund: async (reason: string) => {
      await creditsService.refundCredits({
        organizationId,
        amount: cost.billedCost,
        description: `X API ${cost.operation} refund`,
        metadata: {
          ...xBillingMetadata(cost),
          type: `x_${cost.operation}_refund`,
          reason,
        },
      });
    },
  };
}

async function runChargedXOperation<T>(
  organizationId: string,
  cost: XOperationCostMetadata,
  run: () => Promise<T>,
): Promise<T> {
  const charge = await chargeXOperation(organizationId, cost);
  try {
    return await run();
  } catch (error) {
    try {
      await charge.refund("upstream_failure");
    } catch (refundError) {
      logger.error("[XService] Failed to refund X operation after upstream failure", {
        organizationId,
        operation: cost.operation,
        error: refundError instanceof Error ? refundError.message : String(refundError),
      });
    }
    throw error;
  }
}

function readOptionalCredential(credentials: Record<string, string>, key: string): string | null {
  const value = credentials[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

function readCredential(credentials: Record<string, string>, key: string, status: number): string {
  const value = readOptionalCredential(credentials, key);
  if (!value) {
    fail(status, `X credential ${key} is missing`);
  }
  return value;
}

function normalizeXCloudCredentials(credentials: Record<string, string>): XCloudCredentials {
  const oauth2AccessToken = readOptionalCredential(credentials, "TWITTER_OAUTH_ACCESS_TOKEN");
  const oauth1AccessToken = readOptionalCredential(credentials, "TWITTER_ACCESS_TOKEN");
  const oauth1AccessSecret = readOptionalCredential(credentials, "TWITTER_ACCESS_TOKEN_SECRET");
  if (oauth2AccessToken && (!oauth1AccessToken || !oauth1AccessSecret)) {
    return {
      authMode: "oauth2",
      accessToken: oauth2AccessToken,
    };
  }

  return {
    authMode: "oauth1a",
    appKey: readCredential(credentials, "TWITTER_API_KEY", 503),
    appSecret: readCredential(credentials, "TWITTER_API_SECRET_KEY", 503),
    accessToken: oauth1AccessToken ?? readCredential(credentials, "TWITTER_ACCESS_TOKEN", 401),
    accessSecret:
      oauth1AccessSecret ?? readCredential(credentials, "TWITTER_ACCESS_TOKEN_SECRET", 401),
  };
}

export async function requireXCloudCredentials(
  organizationId: string,
  connectionRole: OAuthConnectionRole = "owner",
): Promise<XCloudCredentials> {
  if (!twitterAutomationService.isConfigured()) {
    throw new XServiceError(503, "X integration is not configured on this platform");
  }

  const role = normalizeConnectionRole(connectionRole);
  const credentials = await twitterAutomationService.getCredentialsForAgent(organizationId, role);
  if (!credentials) {
    throw new XServiceError(401, `X ${role} account is not connected for this organization`);
  }

  return normalizeXCloudCredentials(credentials);
}

function createXClientFromCredentials(credentials: XCloudCredentials): XClient {
  if (credentials.authMode === "oauth2") {
    return new TwitterApi(credentials.accessToken);
  }
  return new TwitterApi({
    appKey: credentials.appKey,
    appSecret: credentials.appSecret,
    accessToken: credentials.accessToken,
    accessSecret: credentials.accessSecret,
  });
}

async function createXClient(
  organizationId: string,
  connectionRole: OAuthConnectionRole = "owner",
): Promise<XClient> {
  const credentials = await requireXCloudCredentials(organizationId, connectionRole);
  return createXClientFromCredentials(credentials);
}

function mapXApiStatus(error: unknown): number {
  if (!(error instanceof Error)) return 502;
  const xError = error as XApiError;
  const upstreamStatus = xError.data?.status ?? xError.code;
  if (upstreamStatus === 401) return 401;
  if (upstreamStatus === 403) return 403;
  if (upstreamStatus === 429) return 429;
  if (typeof upstreamStatus === "number" && upstreamStatus >= 400 && upstreamStatus < 500) {
    return upstreamStatus;
  }
  return 502;
}

function addXApiErrorPart(parts: string[], value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) {
    parts.push(value.trim());
  }
}

function formatXApiError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const xError = error as XApiError;
  const parts = [error.message || fallback];

  addXApiErrorPart(parts, xError.data?.detail);
  addXApiErrorPart(parts, xError.data?.title);
  addXApiErrorPart(parts, xError.data?.error);

  const errors = Array.isArray(xError.data?.errors) ? xError.data.errors : [];
  for (const item of errors) {
    addXApiErrorPart(parts, item.detail);
    addXApiErrorPart(parts, item.message);
    addXApiErrorPart(parts, item.title);

    const nestedErrors = Array.isArray(item.errors) ? item.errors : [];
    for (const nested of nestedErrors) {
      addXApiErrorPart(parts, nested.message);
    }
  }
  if (xError.rateLimit?.remaining === 0 && xError.rateLimit.reset) {
    parts.push(`rate limit resets at ${new Date(xError.rateLimit.reset * 1000).toISOString()}`);
  }
  return [...new Set(parts)].join(" - ");
}

function throwXApiError(error: unknown, fallback: string): never {
  if (error instanceof XServiceError) throw error;
  throw new XServiceError(mapXApiStatus(error), formatXApiError(error, fallback));
}

function mapAuthenticatedUser(user: UserV2): XAuthenticatedUser {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    description: user.description ?? null,
    profileImageUrl: user.profile_image_url ?? null,
    verified: user.verified ?? null,
    publicMetrics: user.public_metrics ?? null,
  };
}

async function getAuthenticatedUser(client: XClient): Promise<XAuthenticatedUser> {
  const me = await client.v2.me({
    "user.fields": X_USER_FIELDS,
  });
  return mapAuthenticatedUser(me.data);
}

function mapDirectMessage(event: XDirectMessageEventV2, selfUserId: string): XDirectMessage | null {
  if (event.event_type !== "MessageCreate") {
    return null;
  }

  const senderId = event.sender_id;
  if (!senderId) {
    return null;
  }

  const participantIds = [...new Set(event.participant_ids ?? [])];
  const otherParticipantId =
    participantIds.find((participantId) => participantId !== selfUserId) ??
    (senderId === selfUserId ? "" : senderId);
  if (!otherParticipantId) {
    return null;
  }

  const direction = senderId === selfUserId ? "sent" : "received";
  const recipientId = direction === "sent" ? otherParticipantId : selfUserId;

  return {
    id: event.id,
    text: event.text ?? "",
    createdAt: event.created_at ?? null,
    conversationId: event.dm_conversation_id ?? "",
    participantIds,
    senderId,
    recipientId,
    participantId: otherParticipantId,
    direction,
    entities: event.entities ?? null,
    hasAttachment: Boolean(
      event.attachments?.media_keys?.length || event.attachments?.card_ids?.length,
    ),
  };
}

async function listDirectMessages(args: {
  client: XClient;
  selfUserId: string;
  maxResults?: number;
}): Promise<XDirectMessage[]> {
  const limit = normalizeDmLimit(args.maxResults);
  const timeline = (await args.client.v2.listDmEvents({
    max_results: limit,
    "dm_event.fields": [
      "id",
      "text",
      "event_type",
      "created_at",
      "sender_id",
      "dm_conversation_id",
      "attachments",
      "participant_ids",
      "entities",
    ],
    event_types: ["MessageCreate"],
    expansions: ["sender_id", "participant_ids"],
  })) as XDirectMessageTimelineV2;

  return timeline.events
    .map((event) => mapDirectMessage(event, args.selfUserId))
    .filter((message): message is XDirectMessage => message !== null);
}

function mapFeedItem(tweet: TweetV2, author: UserV2 | undefined): XFeedItem {
  return {
    id: tweet.id,
    text: tweet.text ?? "",
    createdAt: tweet.created_at ?? null,
    authorId: tweet.author_id ?? "",
    authorHandle: author?.username ?? "",
    conversationId: tweet.conversation_id ?? null,
    referencedTweets: (tweet.referenced_tweets ?? []).map((reference) => ({
      type: reference.type,
      id: reference.id,
    })),
    publicMetrics: tweet.public_metrics ?? null,
    entities: tweet.entities ?? null,
  };
}

async function listFeedItems(args: {
  client: XClient;
  selfUserId: string;
  feedType: XFeedType;
  query?: string;
  maxResults?: number;
}): Promise<XFeedItem[]> {
  const limit = normalizeFeedLimit(args.maxResults);
  const options = {
    max_results: limit,
    "tweet.fields": X_FEED_TWEET_FIELDS,
    expansions: X_FEED_EXPANSIONS,
    "user.fields": X_FEED_USER_FIELDS,
  };
  const paginator =
    args.feedType === "search"
      ? await args.client.v2.search(normalizeText(args.query ?? "", "query", 512), {
          ...options,
          sort_order: "recency" as const,
        })
      : args.feedType === "mentions"
        ? await args.client.v2.userMentionTimeline(args.selfUserId, options)
        : await args.client.v2.homeTimeline(options);

  return paginator.tweets.map((tweet) => mapFeedItem(tweet, paginator.includes.author(tweet)));
}

function scoreDirectMessage(message: XDirectMessage, now: number): XDmCurationItem {
  const text = message.text.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (message.direction === "received") {
    score += 30;
    reasons.push("incoming");
  }

  if (/\?/.test(message.text)) {
    score += 15;
    reasons.push("question");
  }

  if (/\b(urgent|asap|today|now|deadline|blocked|help|important)\b/i.test(message.text)) {
    score += 25;
    reasons.push("time-sensitive");
  }

  if (/\b(can you|could you|please|need|send|review|confirm|reply)\b/i.test(message.text)) {
    score += 15;
    reasons.push("action requested");
  }

  const createdAt = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
  if (Number.isFinite(createdAt)) {
    const ageHours = (now - createdAt) / 3_600_000;
    if (ageHours <= 24) {
      score += 20;
      reasons.push("recent");
    } else if (ageHours <= 72) {
      score += 10;
      reasons.push("this week");
    }
  }

  if (text.includes("thank")) {
    score -= 5;
  }

  const priority = score >= 70 ? "high" : score >= 45 ? "medium" : "low";
  const recommendedAction =
    message.direction === "received" && score >= 45
      ? "reply"
      : message.direction === "received"
        ? "review"
        : "archive";

  return {
    message,
    curationScore: Math.max(0, score),
    priority,
    recommendedAction,
    reason: reasons.length > 0 ? reasons.join(", ") : "low-signal",
  };
}

export async function getXCloudStatus(
  organizationId: string,
  connectionRole: OAuthConnectionRole = "owner",
): Promise<{
  configured: boolean;
  connected: boolean;
  connectionRole: OAuthConnectionRole;
  status: {
    connected: boolean;
    username?: string;
    userId?: string;
    avatarUrl?: string;
  };
  me: XAuthenticatedUser | null;
  cost: XOperationCostMetadata;
}> {
  if (!twitterAutomationService.isConfigured()) {
    throw new XServiceError(503, "X integration is not configured on this platform");
  }

  const cost = await resolveXOperationCost("status");
  const role = normalizeConnectionRole(connectionRole);
  const credentials = await twitterAutomationService.getCredentialsForAgent(organizationId, role);
  if (!credentials) {
    return {
      configured: true,
      connected: false,
      connectionRole: role,
      status: { connected: false },
      me: null,
      cost,
    };
  }

  try {
    const client = createXClientFromCredentials(normalizeXCloudCredentials(credentials));
    return await runChargedXOperation(organizationId, cost, async () => {
      const me = await getAuthenticatedUser(client);
      return {
        configured: true,
        connected: true,
        connectionRole: role,
        status: {
          connected: true,
          username: me.username,
          userId: me.id,
          avatarUrl: me.profileImageUrl ?? undefined,
        },
        me,
        cost,
      };
    });
  } catch (error) {
    throwXApiError(error, "Failed to fetch X account status");
  }
}

export async function createXPost(args: {
  organizationId: string;
  connectionRole?: OAuthConnectionRole;
  text: string;
  replyToTweetId?: string;
  quoteTweetId?: string;
}): Promise<{
  posted: boolean;
  operation: "post";
  tweet: {
    id: string;
    text: string;
    url: string;
  };
  cost: XOperationCostMetadata;
}> {
  const text = normalizeText(args.text, "text", MAX_TWEET_LENGTH);
  const replyToTweetId = args.replyToTweetId
    ? normalizeSnowflake(args.replyToTweetId, "replyToTweetId")
    : undefined;
  const quoteTweetId = args.quoteTweetId
    ? normalizeSnowflake(args.quoteTweetId, "quoteTweetId")
    : undefined;
  const role = normalizeConnectionRole(args.connectionRole);
  const cost = await resolveXOperationCost("post");
  const client = await createXClient(args.organizationId, role);
  const payload: Partial<SendTweetV2Params> = {};

  if (replyToTweetId) {
    payload.reply = { in_reply_to_tweet_id: replyToTweetId };
  }
  if (quoteTweetId) {
    payload.quote_tweet_id = quoteTweetId;
  }

  try {
    return await runChargedXOperation(args.organizationId, cost, async () => {
      const tweet = await client.v2.tweet(text, payload);
      return {
        posted: true,
        operation: "post",
        tweet: {
          id: tweet.data.id,
          text: tweet.data.text,
          url: `https://x.com/i/status/${tweet.data.id}`,
        },
        cost,
      };
    });
  } catch (error) {
    throwXApiError(error, "Failed to create X post");
  }
}

export async function sendXDm(args: {
  organizationId: string;
  connectionRole?: OAuthConnectionRole;
  participantId: string;
  text: string;
}): Promise<{
  sent: boolean;
  operation: "dm.send";
  message: XDirectMessage;
  cost: XOperationCostMetadata;
}> {
  const participantId = normalizeSnowflake(args.participantId, "participantId");
  const text = normalizeText(args.text, "text", MAX_DM_LENGTH);
  const role = normalizeConnectionRole(args.connectionRole);
  const cost = await resolveXOperationCost("dm.send");
  const client = await createXClient(args.organizationId, role);

  try {
    return await runChargedXOperation(args.organizationId, cost, async () => {
      const me = await getAuthenticatedUser(client);
      const result = await client.v2.sendDmToParticipant(participantId, {
        text,
      });
      return {
        sent: true,
        operation: "dm.send",
        message: {
          id: result.dm_event_id,
          text,
          createdAt: new Date().toISOString(),
          conversationId: result.dm_conversation_id,
          participantIds: [me.id, participantId],
          senderId: me.id,
          recipientId: participantId,
          participantId,
          direction: "sent",
          entities: null,
          hasAttachment: false,
        },
        cost,
      };
    });
  } catch (error) {
    throwXApiError(error, "Failed to send X direct message");
  }
}

export async function sendXDmToConversation(args: {
  organizationId: string;
  connectionRole?: OAuthConnectionRole;
  conversationId: string;
  text: string;
}): Promise<{
  sent: boolean;
  operation: "dm.send";
  message: XDirectMessage;
  cost: XOperationCostMetadata;
}> {
  const conversationId = normalizeSnowflake(args.conversationId, "conversationId");
  const text = normalizeText(args.text, "text", MAX_DM_LENGTH);
  const role = normalizeConnectionRole(args.connectionRole);
  const cost = await resolveXOperationCost("dm.send");
  const client = await createXClient(args.organizationId, role);

  try {
    return await runChargedXOperation(args.organizationId, cost, async () => {
      const me = await getAuthenticatedUser(client);
      const result = await client.v2.sendDmInConversation(conversationId, {
        text,
      });
      return {
        sent: true,
        operation: "dm.send",
        message: {
          id: result.dm_event_id,
          text,
          createdAt: new Date().toISOString(),
          conversationId: result.dm_conversation_id,
          participantIds: [],
          senderId: me.id,
          recipientId: conversationId,
          participantId: conversationId,
          direction: "sent",
          entities: null,
          hasAttachment: false,
        },
        cost,
      };
    });
  } catch (error) {
    throwXApiError(error, "Failed to send X direct message to conversation");
  }
}

export async function createXDmGroup(args: {
  organizationId: string;
  connectionRole?: OAuthConnectionRole;
  participantIds: string[];
  text: string;
}): Promise<{
  created: boolean;
  operation: "dm.send";
  conversationId: string;
  message: XDirectMessage;
  cost: XOperationCostMetadata;
}> {
  const participantIds = normalizeParticipantIds(args.participantIds);
  const text = normalizeText(args.text, "text", MAX_DM_LENGTH);
  const role = normalizeConnectionRole(args.connectionRole);
  const cost = await resolveXOperationCost("dm.send");
  const client = await createXClient(args.organizationId, role);

  try {
    return await runChargedXOperation(args.organizationId, cost, async () => {
      const me = await getAuthenticatedUser(client);
      const result = await client.v2.createDmConversation({
        conversation_type: "Group",
        participant_ids: participantIds,
        message: { text },
      });
      return {
        created: true,
        operation: "dm.send",
        conversationId: result.dm_conversation_id,
        message: {
          id: result.dm_event_id,
          text,
          createdAt: new Date().toISOString(),
          conversationId: result.dm_conversation_id,
          participantIds: [me.id, ...participantIds],
          senderId: me.id,
          recipientId: result.dm_conversation_id,
          participantId: result.dm_conversation_id,
          direction: "sent",
          entities: null,
          hasAttachment: false,
        },
        cost,
      };
    });
  } catch (error) {
    throwXApiError(error, "Failed to create X group direct message");
  }
}

export async function getXFeed(args: {
  organizationId: string;
  connectionRole?: OAuthConnectionRole;
  feedType?: string;
  query?: string;
  maxResults?: number;
}): Promise<{
  operation: "feed.read";
  feedType: XFeedType;
  items: XFeedItem[];
  syncedAt: string;
  cost: XOperationCostMetadata;
}> {
  const feedType = normalizeFeedType(args.feedType ?? "home_timeline");
  const role = normalizeConnectionRole(args.connectionRole);
  const cost = await resolveXOperationCost("feed.read");
  const client = await createXClient(args.organizationId, role);

  try {
    return await runChargedXOperation(args.organizationId, cost, async () => {
      const me = await getAuthenticatedUser(client);
      const items = await listFeedItems({
        client,
        selfUserId: me.id,
        feedType,
        query: args.query,
        maxResults: args.maxResults,
      });
      return {
        operation: "feed.read",
        feedType,
        items,
        syncedAt: new Date().toISOString(),
        cost,
      };
    });
  } catch (error) {
    throwXApiError(error, "Failed to read X feed");
  }
}

export async function getXDmDigest(args: {
  organizationId: string;
  connectionRole?: OAuthConnectionRole;
  maxResults?: number;
}): Promise<{
  operation: "dm.digest";
  digest: {
    totalMessages: number;
    receivedCount: number;
    sentCount: number;
    participantIds: string[];
    latestMessageAt: string | null;
  };
  messages: XDirectMessage[];
  syncedAt: string;
  cost: XOperationCostMetadata;
}> {
  const maxResults = normalizeDmLimit(args.maxResults);
  const role = normalizeConnectionRole(args.connectionRole);
  const cost = await resolveXOperationCost("dm.digest");
  const client = await createXClient(args.organizationId, role);

  try {
    return await runChargedXOperation(args.organizationId, cost, async () => {
      const me = await getAuthenticatedUser(client);
      const messages = await listDirectMessages({
        client,
        selfUserId: me.id,
        maxResults,
      });
      const receivedCount = messages.filter((message) => message.direction === "received").length;
      const sentCount = messages.length - receivedCount;
      const participantIds = [...new Set(messages.map((message) => message.participantId))];
      const latestMessageAt = messages[0]?.createdAt ?? null;

      return {
        operation: "dm.digest",
        digest: {
          totalMessages: messages.length,
          receivedCount,
          sentCount,
          participantIds,
          latestMessageAt,
        },
        messages,
        syncedAt: new Date().toISOString(),
        cost,
      };
    });
  } catch (error) {
    throwXApiError(error, "Failed to fetch X direct message digest");
  }
}

export async function curateXDms(args: {
  organizationId: string;
  connectionRole?: OAuthConnectionRole;
  maxResults?: number;
}): Promise<{
  operation: "dm.curate";
  items: XDmCurationItem[];
  syncedAt: string;
  cost: XOperationCostMetadata;
}> {
  const maxResults = normalizeDmLimit(args.maxResults);
  const role = normalizeConnectionRole(args.connectionRole);
  const cost = await resolveXOperationCost("dm.curate");
  const client = await createXClient(args.organizationId, role);

  try {
    return await runChargedXOperation(args.organizationId, cost, async () => {
      const me = await getAuthenticatedUser(client);
      const messages = await listDirectMessages({
        client,
        selfUserId: me.id,
        maxResults,
      });
      const now = Date.now();
      const items = messages
        .filter((message) => message.direction === "received")
        .map((message) => scoreDirectMessage(message, now))
        .sort((left, right) => {
          const scoreDelta = right.curationScore - left.curationScore;
          if (scoreDelta !== 0) return scoreDelta;
          return (
            Date.parse(right.message.createdAt ?? "1970-01-01T00:00:00.000Z") -
            Date.parse(left.message.createdAt ?? "1970-01-01T00:00:00.000Z")
          );
        });

      return {
        operation: "dm.curate",
        items,
        syncedAt: new Date().toISOString(),
        cost,
      };
    });
  } catch (error) {
    throwXApiError(error, "Failed to curate X direct messages");
  }
}

export { resolveXOperationCost };
