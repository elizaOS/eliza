/** Unit tests for the `Client` direct-message methods, driving a hand-rolled fake twitter-api-v2 `v2` client. */
import { describe, expect, it, vi } from "vitest";
import { Client } from "./client";

function createClient(v2: Record<string, unknown>) {
  const client = new Client();
  client.updateAuth({
    getV2Client: async () => ({ v2 }),
  } as never);

  return client;
}

describe("Client direct messages", () => {
  it("fetches one-to-one direct message events for a participant", async () => {
    const listDmEventsWithParticipant = vi.fn().mockResolvedValue({
      events: [
        {
          id: "event-1",
          event_type: "MessageCreate",
          text: "hello",
        },
      ],
    });
    const client = createClient({ listDmEventsWithParticipant });

    const result = await client.getDirectMessageConversations(
      "user-1",
      "cursor-1",
    );

    expect(listDmEventsWithParticipant).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        pagination_token: "cursor-1",
        event_types: ["MessageCreate"],
      }),
    );
    expect(result.conversations).toEqual([
      {
        id: "event-1",
        event_type: "MessageCreate",
        text: "hello",
      },
    ]);
  });

  it("handles direct message pages without events", async () => {
    const listDmEventsWithParticipant = vi.fn().mockResolvedValue({});
    const client = createClient({ listDmEventsWithParticipant });

    const result = await client.getDirectMessageConversations("user-1");

    expect(result.conversations).toEqual([]);
  });

  it("sends a direct message into a conversation", async () => {
    const sendDmInConversation = vi.fn().mockResolvedValue({
      dm_conversation_id: "conversation-1",
      dm_event_id: "event-1",
    });
    const client = createClient({ sendDmInConversation });

    const result = await client.sendDirectMessage("conversation-1", "hello");

    expect(sendDmInConversation).toHaveBeenCalledWith("conversation-1", {
      text: "hello",
    });
    expect(result).toEqual({
      id: "event-1",
      data: {
        dm_conversation_id: "conversation-1",
        dm_event_id: "event-1",
      },
    });
  });
});
