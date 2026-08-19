/** Provides deterministic, stateful MessageConnector fixtures for corpus-level messaging contracts without claiming live-provider evidence. */

import {
  type Content,
  createMessageMemory,
  type IAgentRuntime,
  type Memory,
  type MessageConnectorRegistration,
  type MessageConnectorTarget,
  ModelType,
  stringToUuid,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";

export interface FixtureConversation {
  channelId: string;
  label: string;
  kind: "contact" | "phone" | "user" | "group" | "room" | "channel";
  messages: Array<{
    id: string;
    sender: string;
    text: string;
    createdAt: number;
  }>;
  /** Raw platform recipient ID used to exercise the owner-confirmation gate. */
  recipientId?: string;
}

export interface FixtureDispatch {
  target: TargetInfo;
  content: Content;
  providerMessageId: string;
}

export interface StatefulMessageConnectorFixture {
  readonly source: string;
  readonly accountId: string;
  readonly reads: Array<{ target: TargetInfo; limit?: number }>;
  readonly userLookups: Array<{
    userId?: string;
    username?: string;
    handle?: string;
  }>;
  readonly dispatches: FixtureDispatch[];
  register(runtime: IAgentRuntime, roomId: UUID): void;
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[@#]+/, "");
}

function toMemory(args: {
  runtime: IAgentRuntime;
  roomId: UUID;
  source: string;
  accountId: string;
  conversation: FixtureConversation;
  message: FixtureConversation["messages"][number];
}): Memory {
  const memory = createMessageMemory({
    id: stringToUuid(`${args.source}:${args.message.id}`) as UUID,
    agentId: args.runtime.agentId,
    entityId: stringToUuid(
      `${args.source}:sender:${args.message.sender}`,
    ) as UUID,
    roomId: args.roomId,
    content: {
      text: args.message.text,
      source: args.source,
    },
  }) as Memory;
  memory.createdAt = args.message.createdAt;
  memory.metadata = {
    type: "message",
    accountId: args.accountId,
    platformMessageId: args.message.id,
    senderName: args.message.sender,
    channelId: args.conversation.channelId,
    conversationLabel: args.conversation.label,
  } as Memory["metadata"];
  return memory;
}

export function createStatefulMessageConnectorFixture(args: {
  source: string;
  label: string;
  accountId?: string;
  conversations: FixtureConversation[];
}): StatefulMessageConnectorFixture {
  const accountId = args.accountId ?? "test-owner";
  const reads: Array<{ target: TargetInfo; limit?: number }> = [];
  const userLookups: Array<{
    userId?: string;
    username?: string;
    handle?: string;
  }> = [];
  const dispatches: FixtureDispatch[] = [];

  return {
    source: args.source,
    accountId,
    reads,
    userLookups,
    dispatches,
    register(runtime, roomId) {
      reads.length = 0;
      userLookups.length = 0;
      dispatches.length = 0;
      const targetFor = (
        conversation: FixtureConversation,
      ): MessageConnectorTarget => ({
        target: {
          source: args.source,
          accountId,
          // A raw recipient ID with no channel address intentionally uses the
          // runtime's unvetted-recipient confirmation gate before dispatch.
          ...(conversation.recipientId
            ? { entityId: conversation.recipientId as UUID }
            : { channelId: conversation.channelId }),
        },
        label: conversation.label,
        kind: conversation.kind,
        score: 1,
        metadata: {
          channelId: conversation.channelId,
          fixture: true,
        },
      });

      const registration: MessageConnectorRegistration = {
        source: args.source,
        accountId,
        label: args.label,
        capabilities: [
          "send_message",
          "read_messages",
          "search_messages",
          "get_user",
          "chat_context",
          "contact_resolution",
        ],
        supportedTargetKinds: [
          "contact",
          "phone",
          "user",
          "group",
          "room",
          "channel",
        ],
        contexts: ["social", "connectors"],
        description: `${args.label} deterministic stateful connector fixture`,
        metadata: { fixture: true, accountId },
        resolveTargets: (query) => {
          const needle = normalize(query);
          return args.conversations
            .filter((conversation) =>
              [
                conversation.label,
                conversation.channelId,
                conversation.recipientId ?? "",
              ]
                .map(normalize)
                .some((candidate) => candidate.includes(needle)),
            )
            .map(targetFor);
        },
        listRecentTargets: () => args.conversations.map(targetFor),
        fetchMessages: (_context, params) => {
          reads.push({ target: { ...params.target }, limit: params.limit });
          const conversation = args.conversations.find(
            (candidate) =>
              candidate.channelId === params.target.channelId ||
              candidate.recipientId === params.target.entityId,
          );
          if (!conversation) return [];
          return conversation.messages
            .map((message) =>
              toMemory({
                runtime,
                roomId,
                source: args.source,
                accountId,
                conversation,
                message,
              }),
            )
            .sort(
              (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
            )
            .slice(0, params.limit);
        },
        getUser: async (_handlerRuntime, params) => {
          const lookup = {
            userId:
              typeof params.userId === "string" ? params.userId : undefined,
            username: params.username,
            handle: params.handle,
          };
          userLookups.push(lookup);
          const needle = normalize(
            lookup.userId ?? lookup.username ?? lookup.handle ?? "",
          );
          const conversation = args.conversations.find((candidate) =>
            [candidate.label, candidate.channelId, candidate.recipientId ?? ""]
              .map(normalize)
              .some((value) => value === needle),
          );
          if (!conversation) return null;
          return {
            id: stringToUuid(
              `${args.source}:user:${conversation.recipientId ?? conversation.channelId}`,
            ),
            names: [conversation.label],
            metadata: {
              accountId,
              source: args.source,
              handle: conversation.recipientId ?? conversation.channelId,
            },
          };
        },
        sendHandler: async (_handlerRuntime, target, content) => {
          const providerMessageId = `${args.source}-fixture-${dispatches.length + 1}`;
          dispatches.push({
            target: { ...target },
            content: structuredClone(content),
            providerMessageId,
          });
          return {
            kind: "delivered",
            receipt: {
              providerMessageIds: [providerMessageId],
              acceptedAt: Date.now(),
              persistence: {
                status: "not_attempted",
                reason:
                  "scenario fixture records provider acceptance in its dispatch ledger",
              },
            },
            memories: [],
          };
        },
      };
      runtime.registerMessageConnector(registration);
    },
  };
}

export function registerFixtureSeed(fixture: StatefulMessageConnectorFixture): {
  type: "custom";
  name: string;
  apply: (ctx: ScenarioContext) => string | undefined;
} {
  return {
    type: "custom",
    name: `register-${fixture.source}-stateful-connector`,
    apply: (ctx) => {
      if (!ctx.runtime || !ctx.primaryRoomId) {
        return "stateful connector fixture requires runtime and primary room";
      }
      fixture.register(ctx.runtime as IAgentRuntime, ctx.primaryRoomId as UUID);
      return undefined;
    },
  };
}

export function registerUnknownEntityResolutionSeed(
  outboundText: string,
  times = 2,
): {
  type: "custom";
  name: string;
  apply: (ctx: ScenarioContext) => string | undefined;
} {
  return {
    type: "custom",
    name: "register-unknown-entity-resolution-fixture",
    apply: (ctx) => {
      const runtime = ctx.runtime as
        | (IAgentRuntime & {
            scenarioModelFixtures?: {
              register: (...fixtures: Array<Record<string, unknown>>) => void;
            };
          })
        | undefined;
      if (!runtime?.scenarioModelFixtures) {
        return "deterministic entity-resolution fixture registry unavailable";
      }
      runtime.scenarioModelFixtures.register({
        name: "message-send-recipient-is-not-a-stored-entity",
        match: {
          modelType: ModelType.TEXT_SMALL,
          input: (value: string) =>
            value.includes("# Task: Resolve Entity Name"),
        },
        response: {
          entityId: null,
          type: "UNKNOWN",
          matches: [],
        },
        times,
      });
      runtime.scenarioModelFixtures.register({
        name: "preserve-approved-message-voice",
        match: {
          modelType: ModelType.TEXT_SMALL,
          input: (value: string) =>
            value.includes("Rewrite the message below") &&
            value.includes(`Message to rewrite:\n${outboundText}`),
        },
        response: outboundText,
        times: 1,
      });
      return undefined;
    },
  };
}
