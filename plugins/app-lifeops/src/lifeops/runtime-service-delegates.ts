import type {
  Content,
  IAgentRuntime,
  Memory,
  TargetInfo,
} from "@elizaos/core";
import type { LifeOpsConnectorGrant } from "../contracts/index.js";
import type {
  CalendlyAvailability,
  CalendlyScheduledEvent,
  CalendlySingleUseLink,
} from "./calendly-client.js";
import type { WhatsAppSendRequest } from "./whatsapp-client.js";

export type RuntimeServiceDelegationResult<T> =
  | {
      status: "handled";
      accountId: string;
      value: T;
    }
  | {
      status: "fallback";
      reason: string;
      error?: unknown;
    };

type ConnectorGrantAccountRef = Pick<
  LifeOpsConnectorGrant,
  "id" | "connectorAccountId" | "cloudConnectionId" | "metadata"
>;

type ConnectorQueryContext = {
  runtime: IAgentRuntime;
  source: string;
  accountId: string;
  account: { accountId: string };
  target?: TargetInfo;
};

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function resolveRuntimeConnectorAccountId(args: {
  accountId?: string | null;
  grant?: ConnectorGrantAccountRef | null;
  defaultAccountId?: string;
}): string {
  const metadata = objectRecord(args.grant?.metadata);
  return (
    trimmedString(args.accountId) ??
    trimmedString(args.grant?.connectorAccountId) ??
    trimmedString(metadata?.accountId) ??
    trimmedString(metadata?.connectorAccountId) ??
    trimmedString(args.grant?.cloudConnectionId) ??
    args.defaultAccountId ??
    "default"
  );
}

function getRuntimeService<T>(
  runtime: IAgentRuntime,
  serviceTypes: readonly string[],
): T | null {
  for (const serviceType of serviceTypes) {
    const service = runtime.getService?.(serviceType);
    if (service && typeof service === "object") {
      return service as T;
    }
  }
  return null;
}

function connectorContext(args: {
  runtime: IAgentRuntime;
  source: string;
  accountId: string;
  target?: TargetInfo;
}): ConnectorQueryContext {
  return {
    runtime: args.runtime,
    source: args.source,
    accountId: args.accountId,
    account: { accountId: args.accountId },
    target: args.target
      ? ({ ...args.target, accountId: args.accountId } as TargetInfo)
      : undefined,
  };
}

function connectorTarget(args: {
  source: string;
  accountId: string;
  channelId?: string;
  threadId?: string;
  entityId?: string;
  roomId?: string;
  metadata?: Record<string, unknown>;
}): TargetInfo {
  return {
    source: args.source,
    accountId: args.accountId,
    channelId: args.channelId,
    threadId: args.threadId,
    entityId: args.entityId,
    roomId: args.roomId,
    metadata: {
      ...args.metadata,
      accountId: args.accountId,
    },
  } as TargetInfo;
}

function fallback<T>(
  reason: string,
  error?: unknown,
): RuntimeServiceDelegationResult<T> {
  return error === undefined
    ? { status: "fallback", reason }
    : { status: "fallback", reason, error };
}

type XRuntimeServiceLike = {
  getAccountStatus?: (accountId: string) => Promise<{
    accountId?: string;
    configured?: boolean;
    connected?: boolean;
    reason?: string;
    identity?: Record<string, unknown> | null;
    grantedCapabilities?: string[];
    grantedScopes?: string[];
    authMode?: string;
  }>;
  sendDirectMessageForAccount?: (
    accountId: string,
    params: { participantId: string; text: string },
  ) => Promise<{ ok?: boolean; status?: number; messageId?: string | null }>;
  fetchDirectMessagesForAccount?: (
    accountId: string,
    params?: { participantId?: string; limit?: number },
  ) => Promise<Memory[]>;
  createPostForAccount?: (
    accountId: string,
    params: { text: string; replyToTweetId?: string },
  ) => Promise<Memory>;
  fetchFeedForAccount?: (
    accountId: string,
    params?: {
      feedType?: string;
      userId?: string;
      limit?: number;
      cursor?: string;
    },
  ) => Promise<Memory[]>;
  searchPostsForAccount?: (
    accountId: string,
    params: { query: string; limit?: number; cursor?: string },
  ) => Promise<Memory[]>;
  sendDirectMessageToConversationForAccount?: (
    accountId: string,
    params: { conversationId: string; text: string },
  ) => Promise<{ ok?: boolean; status?: number; messageId?: string | null }>;
  createDirectMessageGroupForAccount?: (
    accountId: string,
    params: { participantIds: string[]; text: string },
  ) => Promise<{
    ok?: boolean;
    status?: number;
    conversationId?: string | null;
    messageId?: string | null;
  }>;
  handleSendMessage?: (
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ) => Promise<unknown>;
  fetchConnectorMessages?: (
    context: ConnectorQueryContext,
    params: Record<string, unknown>,
  ) => Promise<Memory[]>;
  handleSendPost?: (
    runtime: IAgentRuntime,
    content: Content,
    context?: Record<string, unknown>,
  ) => Promise<Memory>;
  fetchConnectorFeed?: (
    context: ConnectorQueryContext,
    params: Record<string, unknown>,
  ) => Promise<Memory[]>;
  searchConnectorPosts?: (
    context: ConnectorQueryContext,
    params: { query: string; limit?: number; cursor?: string },
  ) => Promise<Memory[]>;
};

function getXRuntimeService(
  runtime: IAgentRuntime,
): XRuntimeServiceLike | null {
  return getRuntimeService<XRuntimeServiceLike>(runtime, ["x", "twitter"]);
}

export async function getXAccountStatusWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
}): Promise<
  RuntimeServiceDelegationResult<{
    accountId: string;
    configured: boolean;
    connected: boolean;
    reason: string;
    identity: Record<string, unknown> | null;
    grantedCapabilities: string[];
    grantedScopes: string[];
    authMode?: string;
  }>
> {
  const service = getXRuntimeService(args.runtime);
  if (typeof service?.getAccountStatus !== "function") {
    return fallback("X runtime service getAccountStatus is not registered.");
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    const status = await service.getAccountStatus(accountId);
    return {
      status: "handled",
      accountId,
      value: {
        accountId: status.accountId ?? accountId,
        configured: status.configured === true,
        connected: status.connected === true,
        reason:
          typeof status.reason === "string" ? status.reason : "connected",
        identity: status.identity ?? null,
        grantedCapabilities: Array.isArray(status.grantedCapabilities)
          ? status.grantedCapabilities
          : [],
        grantedScopes: Array.isArray(status.grantedScopes)
          ? status.grantedScopes
          : [],
        authMode:
          typeof status.authMode === "string" ? status.authMode : undefined,
      },
    };
  } catch (error) {
    return fallback("X runtime service getAccountStatus failed.", error);
  }
}

export async function sendXDirectMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  participantId: string;
  text: string;
}): Promise<
  RuntimeServiceDelegationResult<{
    ok: true;
    status: number | null;
    externalId: string | null;
  }>
> {
  const service = getXRuntimeService(args.runtime);
  if (
    typeof service?.sendDirectMessageForAccount !== "function" &&
    typeof service?.handleSendMessage !== "function"
  ) {
    return fallback("X runtime service handleSendMessage is not registered.");
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.sendDirectMessageForAccount === "function") {
    try {
      const value = await service.sendDirectMessageForAccount(accountId, {
        participantId: args.participantId,
        text: args.text,
      });
      return {
        status: "handled",
        accountId,
        value: {
          ok: true,
          status: value.status ?? 201,
          externalId: value.messageId ?? null,
        },
      };
    } catch (error) {
      return fallback(
        "X runtime service sendDirectMessageForAccount failed.",
        error,
      );
    }
  }

  const target = connectorTarget({
    source: "x",
    accountId,
    channelId: args.participantId,
    entityId: args.participantId,
    metadata: { xUserId: args.participantId },
  });
  const handleSendMessage = service.handleSendMessage;
  if (typeof handleSendMessage !== "function") {
    return fallback("X runtime service handleSendMessage is not registered.");
  }
  try {
    await handleSendMessage(args.runtime, target, {
      text: args.text,
      source: "lifeops",
      metadata: { accountId },
    } as Content);
    return {
      status: "handled",
      accountId,
      value: { ok: true, status: 201, externalId: null },
    };
  } catch (error) {
    return fallback("X runtime service handleSendMessage failed.", error);
  }
}

export async function fetchXDirectMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  participantId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  const service = getXRuntimeService(args.runtime);
  if (
    typeof service?.fetchDirectMessagesForAccount !== "function" &&
    typeof service?.fetchConnectorMessages !== "function"
  ) {
    return fallback(
      "X runtime service fetchConnectorMessages is not registered.",
    );
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.fetchDirectMessagesForAccount === "function") {
    try {
      const value = await service.fetchDirectMessagesForAccount(accountId, {
        participantId: args.participantId,
        limit: args.limit,
      });
      return { status: "handled", accountId, value };
    } catch (error) {
      return fallback(
        "X runtime service fetchDirectMessagesForAccount failed.",
        error,
      );
    }
  }

  const target = args.participantId
    ? connectorTarget({
        source: "x",
        accountId,
        channelId: args.participantId,
        entityId: args.participantId,
      })
    : undefined;
  const fetchConnectorMessages = service.fetchConnectorMessages;
  if (typeof fetchConnectorMessages !== "function") {
    return fallback(
      "X runtime service fetchConnectorMessages is not registered.",
    );
  }
  try {
    const value = await fetchConnectorMessages(
      connectorContext({
        runtime: args.runtime,
        source: "x",
        accountId,
        target,
      }),
      { accountId, target, limit: args.limit },
    );
    return { status: "handled", accountId, value };
  } catch (error) {
    return fallback("X runtime service fetchConnectorMessages failed.", error);
  }
}

export async function createXPostWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  text: string;
  replyToTweetId?: string;
}): Promise<RuntimeServiceDelegationResult<Memory>> {
  const service = getXRuntimeService(args.runtime);
  if (
    typeof service?.createPostForAccount !== "function" &&
    typeof service?.handleSendPost !== "function"
  ) {
    return fallback("X runtime service createPostForAccount is not registered.");
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.createPostForAccount === "function") {
    try {
      const value = await service.createPostForAccount(accountId, {
        text: args.text,
        replyToTweetId: args.replyToTweetId,
      });
      return { status: "handled", accountId, value };
    } catch (error) {
      return fallback("X runtime service createPostForAccount failed.", error);
    }
  }

  try {
    const value = await service.handleSendPost!(
      args.runtime,
      {
        text: args.text,
        ...(args.replyToTweetId ? { replyToTweetId: args.replyToTweetId } : {}),
        metadata: { accountId },
      } as Content,
      {
        runtime: args.runtime,
        source: "x",
        accountId,
        account: { accountId },
        metadata: { accountId },
        target: connectorTarget({ source: "x", accountId }),
      },
    );
    return { status: "handled", accountId, value };
  } catch (error) {
    return fallback("X runtime service handleSendPost failed.", error);
  }
}

export async function fetchXFeedWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  feedType: string;
  limit?: number;
  cursor?: string;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  const service = getXRuntimeService(args.runtime);
  if (
    typeof service?.fetchFeedForAccount !== "function" &&
    typeof service?.fetchConnectorFeed !== "function"
  ) {
    return fallback("X runtime service fetchFeedForAccount is not registered.");
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.fetchFeedForAccount === "function") {
    try {
      const value = await service.fetchFeedForAccount(accountId, {
        feedType: args.feedType,
        limit: args.limit,
        cursor: args.cursor,
      });
      return { status: "handled", accountId, value };
    } catch (error) {
      return fallback("X runtime service fetchFeedForAccount failed.", error);
    }
  }

  try {
    const context = connectorContext({
      runtime: args.runtime,
      source: "x",
      accountId,
    });
    const value = await service.fetchConnectorFeed!(context, {
      accountId,
      feed: args.feedType,
      limit: args.limit,
      cursor: args.cursor,
    });
    return { status: "handled", accountId, value };
  } catch (error) {
    return fallback("X runtime service fetchConnectorFeed failed.", error);
  }
}

export async function searchXPostsWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  query: string;
  limit?: number;
  cursor?: string;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  const service = getXRuntimeService(args.runtime);
  if (
    typeof service?.searchPostsForAccount !== "function" &&
    typeof service?.searchConnectorPosts !== "function"
  ) {
    return fallback("X runtime service searchPostsForAccount is not registered.");
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.searchPostsForAccount === "function") {
    try {
      const value = await service.searchPostsForAccount(accountId, {
        query: args.query,
        limit: args.limit,
        cursor: args.cursor,
      });
      return { status: "handled", accountId, value };
    } catch (error) {
      return fallback("X runtime service searchPostsForAccount failed.", error);
    }
  }

  try {
    const value = await service.searchConnectorPosts!(
      connectorContext({ runtime: args.runtime, source: "x", accountId }),
      { query: args.query, limit: args.limit, cursor: args.cursor },
    );
    return { status: "handled", accountId, value };
  } catch (error) {
    return fallback("X runtime service searchConnectorPosts failed.", error);
  }
}

export async function sendXConversationMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  conversationId: string;
  text: string;
}): Promise<
  RuntimeServiceDelegationResult<{
    ok: true;
    status: number | null;
    externalId: string | null;
  }>
> {
  const service = getXRuntimeService(args.runtime);
  if (typeof service?.sendDirectMessageToConversationForAccount !== "function") {
    return fallback(
      "X runtime service sendDirectMessageToConversationForAccount is not registered.",
    );
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    const value = await service.sendDirectMessageToConversationForAccount(
      accountId,
      {
        conversationId: args.conversationId,
        text: args.text,
      },
    );
    return {
      status: "handled",
      accountId,
      value: {
        ok: true,
        status: value.status ?? 201,
        externalId: value.messageId ?? null,
      },
    };
  } catch (error) {
    return fallback(
      "X runtime service sendDirectMessageToConversationForAccount failed.",
      error,
    );
  }
}

export async function createXDirectMessageGroupWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  participantIds: string[];
  text: string;
}): Promise<
  RuntimeServiceDelegationResult<{
    ok: true;
    status: number | null;
    conversationId: string | null;
    externalId: string | null;
  }>
> {
  const service = getXRuntimeService(args.runtime);
  if (typeof service?.createDirectMessageGroupForAccount !== "function") {
    return fallback(
      "X runtime service createDirectMessageGroupForAccount is not registered.",
    );
  }

  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    const value = await service.createDirectMessageGroupForAccount(accountId, {
      participantIds: args.participantIds,
      text: args.text,
    });
    return {
      status: "handled",
      accountId,
      value: {
        ok: true,
        status: value.status ?? 201,
        conversationId: value.conversationId ?? null,
        externalId: value.messageId ?? null,
      },
    };
  } catch (error) {
    return fallback(
      "X runtime service createDirectMessageGroupForAccount failed.",
      error,
    );
  }
}

type CalendlyRuntimeServiceLike = {
  isConnected?: (accountId?: string) => boolean;
  listEventTypes?: (accountId?: string) => Promise<unknown[]>;
  listScheduledEvents?: (
    options?: Record<string, unknown>,
    accountId?: string,
  ) => Promise<CalendlyScheduledEvent[]>;
  getAvailability?: (
    eventTypeUri: string,
    options: { startDate: string; endDate: string; timezone?: string },
    accountId?: string,
  ) => Promise<CalendlyAvailability[]>;
  createSingleUseLink?: (
    eventTypeUri: string,
    accountId?: string,
  ) => Promise<CalendlySingleUseLink>;
  getBookingUrl?: (
    query?: { durationMinutes?: number; slug?: string },
    accountId?: string,
  ) => Promise<string | null>;
  cancelBooking?: (
    uuid: string,
    reason?: string,
    accountId?: string,
  ) => Promise<void>;
};

export async function listCalendlyEventTypesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
}): Promise<RuntimeServiceDelegationResult<unknown[]>> {
  const service = getRuntimeService<CalendlyRuntimeServiceLike>(args.runtime, [
    "calendly",
  ]);
  if (typeof service?.listEventTypes !== "function") {
    return fallback("Calendly runtime service listEventTypes is not registered.");
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.isConnected === "function" && !service.isConnected(accountId)) {
    return fallback("Calendly runtime service is not connected for accountId.");
  }
  try {
    return {
      status: "handled",
      accountId,
      value: await service.listEventTypes(accountId),
    };
  } catch (error) {
    return fallback("Calendly runtime service listEventTypes failed.", error);
  }
}

export async function getCalendlyBookingUrlWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  query?: { durationMinutes?: number; slug?: string };
}): Promise<RuntimeServiceDelegationResult<string | null>> {
  const service = getRuntimeService<CalendlyRuntimeServiceLike>(args.runtime, [
    "calendly",
  ]);
  if (typeof service?.getBookingUrl !== "function") {
    return fallback("Calendly runtime service getBookingUrl is not registered.");
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.isConnected === "function" && !service.isConnected(accountId)) {
    return fallback("Calendly runtime service is not connected for accountId.");
  }
  try {
    return {
      status: "handled",
      accountId,
      value: await service.getBookingUrl(args.query, accountId),
    };
  } catch (error) {
    return fallback("Calendly runtime service getBookingUrl failed.", error);
  }
}

export async function listCalendlyScheduledEventsWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  options?: Record<string, unknown>;
}): Promise<RuntimeServiceDelegationResult<CalendlyScheduledEvent[]>> {
  const service = getRuntimeService<CalendlyRuntimeServiceLike>(args.runtime, [
    "calendly",
  ]);
  if (typeof service?.listScheduledEvents !== "function") {
    return fallback(
      "Calendly runtime service listScheduledEvents is not registered.",
    );
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.isConnected === "function" && !service.isConnected(accountId)) {
    return fallback("Calendly runtime service is not connected for accountId.");
  }
  try {
    return {
      status: "handled",
      accountId,
      value: await service.listScheduledEvents(args.options, accountId),
    };
  } catch (error) {
    return fallback("Calendly runtime service listScheduledEvents failed.", error);
  }
}

export async function getCalendlyAvailabilityWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  eventTypeUri: string;
  options: { startDate: string; endDate: string; timezone?: string };
}): Promise<RuntimeServiceDelegationResult<CalendlyAvailability[]>> {
  const service = getRuntimeService<CalendlyRuntimeServiceLike>(args.runtime, [
    "calendly",
  ]);
  if (typeof service?.getAvailability !== "function") {
    return fallback("Calendly runtime service getAvailability is not registered.");
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.isConnected === "function" && !service.isConnected(accountId)) {
    return fallback("Calendly runtime service is not connected for accountId.");
  }
  try {
    return {
      status: "handled",
      accountId,
      value: await service.getAvailability(
        args.eventTypeUri,
        args.options,
        accountId,
      ),
    };
  } catch (error) {
    return fallback("Calendly runtime service getAvailability failed.", error);
  }
}

export async function createCalendlySingleUseLinkWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  eventTypeUri: string;
}): Promise<RuntimeServiceDelegationResult<CalendlySingleUseLink>> {
  const service = getRuntimeService<CalendlyRuntimeServiceLike>(args.runtime, [
    "calendly",
  ]);
  if (typeof service?.createSingleUseLink !== "function") {
    return fallback(
      "Calendly runtime service createSingleUseLink is not registered.",
    );
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  if (typeof service.isConnected === "function" && !service.isConnected(accountId)) {
    return fallback("Calendly runtime service is not connected for accountId.");
  }
  try {
    return {
      status: "handled",
      accountId,
      value: await service.createSingleUseLink(args.eventTypeUri, accountId),
    };
  } catch (error) {
    return fallback("Calendly runtime service createSingleUseLink failed.", error);
  }
}

type ConnectorMessageRuntimeServiceLike = {
  handleSendMessage?: (
    runtime: IAgentRuntime,
    target: TargetInfo,
    content: Content,
  ) => Promise<unknown>;
  fetchConnectorMessages?: (
    context: ConnectorQueryContext,
    params: Record<string, unknown>,
  ) => Promise<Memory[]>;
  searchConnectorMessages?: (
    context: ConnectorQueryContext,
    params: Record<string, unknown>,
  ) => Promise<Memory[]>;
};

async function searchMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  serviceType: string;
  source: string;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  query: string;
  channelId?: string;
  roomId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  const service = getRuntimeService<ConnectorMessageRuntimeServiceLike>(
    args.runtime,
    [args.serviceType],
  );
  if (typeof service?.searchConnectorMessages !== "function") {
    return fallback(
      `${args.source} runtime service searchConnectorMessages is not registered.`,
    );
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  const target = connectorTarget({
    source: args.source,
    accountId,
    channelId: args.channelId,
    roomId: args.roomId,
  });
  try {
    const value = await service.searchConnectorMessages(
      connectorContext({
        runtime: args.runtime,
        source: args.source,
        accountId,
        target,
      }),
      {
        accountId,
        target,
        query: args.query,
        channelId: args.channelId,
        roomId: args.roomId,
        limit: args.limit,
      },
    );
    return { status: "handled", accountId, value };
  } catch (error) {
    return fallback(
      `${args.source} runtime service searchConnectorMessages failed.`,
      error,
    );
  }
}

export function searchDiscordMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  query: string;
  channelId?: string;
  roomId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  return searchMessagesWithRuntimeService({
    ...args,
    serviceType: "discord",
    source: "discord",
  });
}

export async function sendDiscordMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  channelId: string;
  text: string;
}): Promise<RuntimeServiceDelegationResult<{ ok: true }>> {
  const service = getRuntimeService<ConnectorMessageRuntimeServiceLike>(
    args.runtime,
    ["discord"],
  );
  if (typeof service?.handleSendMessage !== "function") {
    return fallback("Discord runtime service handleSendMessage is not registered.");
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  const target = connectorTarget({
    source: "discord",
    accountId,
    channelId: args.channelId,
  });
  try {
    await service.handleSendMessage(args.runtime, target, {
      text: args.text,
      source: "lifeops",
      metadata: { accountId },
    } as Content);
    return { status: "handled", accountId, value: { ok: true } };
  } catch (error) {
    return fallback("Discord runtime service handleSendMessage failed.", error);
  }
}

export function searchTelegramMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  query: string;
  channelId?: string;
  roomId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  return searchMessagesWithRuntimeService({
    ...args,
    serviceType: "telegram",
    source: "telegram",
  });
}

export function searchSignalMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  query: string;
  channelId?: string;
  roomId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  return searchMessagesWithRuntimeService({
    ...args,
    serviceType: "signal",
    source: "signal",
  });
}

export async function sendTelegramMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  target: string;
  message: string;
}): Promise<RuntimeServiceDelegationResult<{ ok: true }>> {
  const service = getRuntimeService<ConnectorMessageRuntimeServiceLike>(
    args.runtime,
    ["telegram"],
  );
  if (typeof service?.handleSendMessage !== "function") {
    return fallback("Telegram runtime service handleSendMessage is not registered.");
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  const target = connectorTarget({
    source: "telegram",
    accountId,
    channelId: args.target,
  });
  try {
    await service.handleSendMessage(args.runtime, target, {
      text: args.message,
      source: "lifeops",
      metadata: { accountId },
    } as Content);
    return { status: "handled", accountId, value: { ok: true } };
  } catch (error) {
    return fallback("Telegram runtime service handleSendMessage failed.", error);
  }
}

type SignalRuntimeServiceLike = ConnectorMessageRuntimeServiceLike & {
  getRecentMessages?: (limit?: number, accountId?: string) => Promise<unknown[]>;
  sendMessage?: (
    recipient: string,
    text: string,
    options?: { accountId?: string; record?: boolean },
  ) => Promise<{ timestamp?: number }>;
};

export async function readSignalRecentWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<unknown[]>> {
  const service = getRuntimeService<SignalRuntimeServiceLike>(args.runtime, [
    "signal",
  ]);
  if (typeof service?.getRecentMessages !== "function") {
    return fallback("Signal runtime service getRecentMessages is not registered.");
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    return {
      status: "handled",
      accountId,
      value: await service.getRecentMessages(args.limit, accountId),
    };
  } catch (error) {
    return fallback("Signal runtime service getRecentMessages failed.", error);
  }
}

export async function sendSignalMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  recipient: string;
  text: string;
}): Promise<RuntimeServiceDelegationResult<{ timestamp: number }>> {
  const service = getRuntimeService<SignalRuntimeServiceLike>(args.runtime, [
    "signal",
  ]);
  if (typeof service?.sendMessage !== "function") {
    return fallback("Signal runtime service sendMessage is not registered.");
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    const result = await service.sendMessage(args.recipient, args.text, {
      accountId,
    });
    const timestamp = result.timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      return fallback("Signal runtime service sendMessage returned invalid data.");
    }
    return { status: "handled", accountId, value: { timestamp } };
  } catch (error) {
    return fallback("Signal runtime service sendMessage failed.", error);
  }
}

type WhatsAppRuntimeServiceLike = ConnectorMessageRuntimeServiceLike & {
  sendMessage?: (message: {
    accountId?: string;
    type: "text";
    to: string;
    content: string;
    replyToMessageId?: string;
  }) => Promise<{ messages?: Array<{ id?: string }> }>;
};

function firstMessageId(result: { messages?: Array<{ id?: string }> }): string | null {
  return trimmedString(result.messages?.[0]?.id);
}

export async function sendWhatsAppMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  request: WhatsAppSendRequest;
}): Promise<RuntimeServiceDelegationResult<{ ok: true; messageId: string }>> {
  const service = getRuntimeService<WhatsAppRuntimeServiceLike>(args.runtime, [
    "whatsapp",
  ]);
  if (typeof service?.sendMessage !== "function") {
    return fallback("WhatsApp runtime service sendMessage is not registered.");
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    const sent = await service.sendMessage({
      accountId,
      type: "text",
      to: args.request.to,
      content: args.request.text,
      replyToMessageId: args.request.replyToMessageId,
    });
    const messageId = firstMessageId(sent);
    if (!messageId) {
      return fallback("WhatsApp runtime service sendMessage returned invalid data.");
    }
    return {
      status: "handled",
      accountId,
      value: { ok: true, messageId },
    };
  } catch (error) {
    return fallback("WhatsApp runtime service sendMessage failed.", error);
  }
}

export async function fetchWhatsAppMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  chatId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<Memory[]>> {
  const service = getRuntimeService<WhatsAppRuntimeServiceLike>(args.runtime, [
    "whatsapp",
  ]);
  if (typeof service?.fetchConnectorMessages !== "function") {
    return fallback("WhatsApp runtime service fetchConnectorMessages is not registered.");
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  const target = args.chatId
    ? connectorTarget({ source: "whatsapp", accountId, channelId: args.chatId })
    : undefined;
  try {
    const value = await service.fetchConnectorMessages(
      connectorContext({
        runtime: args.runtime,
        source: "whatsapp",
        accountId,
        target,
      }),
      { accountId, target, channelId: args.chatId, limit: args.limit },
    );
    return { status: "handled", accountId, value };
  } catch (error) {
    return fallback("WhatsApp runtime service fetchConnectorMessages failed.", error);
  }
}

type IMessageRuntimeServiceLike = ConnectorMessageRuntimeServiceLike & {
  sendMessage?: (
    to: string,
    text: string,
    options?: { accountId?: string; mediaUrl?: string; maxBytes?: number },
  ) => Promise<{ success: boolean; messageId?: string; chatId?: string; error?: string }>;
  getMessages?: (options?: {
    chatId?: string;
    limit?: number;
    accountId?: string;
  }) => Promise<unknown[]>;
  getRecentMessages?: (limit?: number) => Promise<unknown[]>;
};

export async function sendIMessageWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  to: string;
  text: string;
  mediaUrl?: string;
  maxBytes?: number;
}): Promise<
  RuntimeServiceDelegationResult<{
    success: boolean;
    messageId?: string;
    chatId?: string;
  }>
> {
  const service = getRuntimeService<IMessageRuntimeServiceLike>(args.runtime, [
    "imessage",
  ]);
  if (typeof service?.sendMessage !== "function") {
    return fallback("iMessage runtime service sendMessage is not registered.");
  }
  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    const sent = await service.sendMessage(args.to, args.text, {
      accountId,
      mediaUrl: args.mediaUrl,
      maxBytes: args.maxBytes,
    });
    if (!sent.success) {
      return fallback(sent.error ?? "iMessage runtime service sendMessage failed.");
    }
    return { status: "handled", accountId, value: sent };
  } catch (error) {
    return fallback("iMessage runtime service sendMessage failed.", error);
  }
}

export async function readIMessagesWithRuntimeService(args: {
  runtime: IAgentRuntime;
  grant?: ConnectorGrantAccountRef | null;
  accountId?: string | null;
  chatId?: string;
  limit?: number;
}): Promise<RuntimeServiceDelegationResult<unknown[]>> {
  const service = getRuntimeService<IMessageRuntimeServiceLike>(args.runtime, [
    "imessage",
  ]);
  const accountId = resolveRuntimeConnectorAccountId(args);
  try {
    if (typeof service?.getMessages === "function") {
      return {
        status: "handled",
        accountId,
        value: await service.getMessages({
          chatId: args.chatId,
          limit: args.limit,
          accountId,
        }),
      };
    }
    if (typeof service?.getRecentMessages === "function") {
      return {
        status: "handled",
        accountId,
        value: await service.getRecentMessages(args.limit),
      };
    }
    return fallback("iMessage runtime service read method is not registered.");
  } catch (error) {
    return fallback("iMessage runtime service read failed.", error);
  }
}
