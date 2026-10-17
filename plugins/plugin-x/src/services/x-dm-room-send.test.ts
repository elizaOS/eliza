/**
 * A reply to a stored X DM room reaches handleSendMessage with the room's
 * channelId, which is the dm_conversation_id ("<id>-<id>"), not a user. The
 * real XService send path runs against a recorded DM transport.
 */
import {
  ChannelType,
  createUniqueUuid,
  type IAgentRuntime,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { XService } from "./x.service";

function harness(ownUserId: string, groupConversationIds: string[] = []) {
  const dmCalls: Array<{ recipient: string; text: string }> = [];
  const conversationCalls: Array<{ conversationId: string; text: string }> = [];
  const profileLookups: string[] = [];
  const session = {
    profile: { userId: ownUserId },
    client: {
      v2: {
        sendDmToParticipant: async (
          recipient: string,
          body: { text: string },
        ) => {
          dmCalls.push({ recipient, text: body.text });
          return { dm_event_id: "9001" };
        },
        sendDmInConversation: async (
          conversationId: string,
          body: { text: string },
        ) => {
          conversationCalls.push({ conversationId, text: body.text });
          return { dm_event_id: "9002" };
        },
      },
    },
  };
  const base = {
    fetchProfile: async (name: string) => {
      profileLookups.push(name);
      throw new Error(`X user not found: ${name}`);
    },
    twitterClient: {
      withAuthenticatedSession: (op: (s: unknown) => unknown) => op(session),
      isAuthenticatedSessionCurrent: () => true,
    },
  };
  const service = Object.create(XService.prototype) as XService & {
    defaultAccountId: string;
    getTwitterClientForAccount: unknown;
  };
  service.defaultAccountId = "default";
  service.getTwitterClientForAccount = async () => ({ client: base });
  const runtime = {
    agentId: "00000000-0000-4000-8000-000000000001",
  } as unknown as IAgentRuntime;
  // The DM poller stores each conversation's room under this id.
  const groupRooms = new Set(
    groupConversationIds.map((id) =>
      createUniqueUuid(runtime, `x-dm:default:${id}`),
    ),
  );
  (runtime as unknown as { getRoom: unknown }).getRoom = async (id: string) =>
    groupRooms.has(id as never) ? { id, type: ChannelType.GROUP } : null;
  const send = (channelId: string) =>
    service.handleSendMessage(
      runtime,
      {
        source: "x",
        roomId: "11111111-1111-4111-8111-111111111111",
        channelId,
      } as never,
      { text: "hello from the inbox" },
    );
  return { dmCalls, conversationCalls, profileLookups, send };
}

describe("X DM reply to a stored DM room", () => {
  it("sends to the other user of the stored conversation", async () => {
    const { dmCalls, profileLookups, send } = harness("1000");
    await send("1000-2000");
    expect(profileLookups).toEqual([]);
    expect(dmCalls).toEqual([
      { recipient: "2000", text: "hello from the inbox" },
    ]);
  });

  it("refuses a conversation that the account is not in", async () => {
    const { dmCalls, send } = harness("3000");
    await expect(send("1000-2000")).rejects.toMatchObject({
      code: "X_DM_CONVERSATION_NOT_OWNED",
    });
    expect(dmCalls).toEqual([]);
  });

  it("still sends to a plain user id", async () => {
    const { dmCalls, send } = harness("1000");
    await send("2000");
    expect(dmCalls).toEqual([
      { recipient: "2000", text: "hello from the inbox" },
    ]);
  });

  it("sends a reply to a stored group DM room into the group conversation", async () => {
    const { dmCalls, conversationCalls, send } = harness("1000", [
      "1700000000000000001",
    ]);
    await send("1700000000000000001");
    expect(dmCalls).toEqual([]);
    expect(conversationCalls).toEqual([
      {
        conversationId: "1700000000000000001",
        text: "hello from the inbox",
      },
    ]);
  });

  it("keeps the group type when connector history reads a group DM", async () => {
    const ownUserId = "1000";
    const groupConversationId = "1700000000000000001";
    const iterator = {
      includes: {
        users: [{ id: "2000", username: "alice" }],
      },
      async *[Symbol.asyncIterator]() {
        yield {
          id: "9003",
          sender_id: "2000",
          dm_conversation_id: groupConversationId,
          participant_ids: [ownUserId, "2000", "3000"],
          text: "hello group",
          event_type: "MessageCreate",
          created_at: "2026-10-17T12:00:00.000Z",
        };
      },
    };
    const session = {
      profile: { userId: ownUserId },
      client: { v2: { listDmEvents: async () => iterator } },
    };
    const base = {
      twitterClient: {
        withAuthenticatedSession: (op: (value: unknown) => unknown) =>
          op(session),
        isAuthenticatedSessionCurrent: () => true,
      },
    };
    const service = Object.create(XService.prototype) as XService & {
      defaultAccountId: string;
      getTwitterClientForAccount: unknown;
    };
    service.defaultAccountId = "default";
    service.getTwitterClientForAccount = async () => ({ client: base });
    const runtime = {
      agentId: "00000000-0000-4000-8000-000000000001",
    } as unknown as IAgentRuntime;

    const messages = await service.fetchConnectorMessages({
      runtime,
      source: "x",
      accountId: "default",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content.channelType).toBe(ChannelType.GROUP);
    expect(messages[0]?.metadata?.chatType).toBe(ChannelType.GROUP);
  });
});
