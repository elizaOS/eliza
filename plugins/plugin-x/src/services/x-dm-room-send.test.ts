/**
 * A reply to a stored X DM room reaches handleSendMessage with the room's
 * channelId, which is the dm_conversation_id ("<id>-<id>"), not a user. The
 * real XService send path runs against a recorded DM transport.
 */
import { describe, expect, it } from "vitest";
import { XService } from "./x.service";

function harness(ownUserId: string) {
  const dmCalls: Array<{ recipient: string; text: string }> = [];
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
  const send = (channelId: string) =>
    service.handleSendMessage(
      {} as never,
      {
        source: "x",
        roomId: "11111111-1111-4111-8111-111111111111",
        channelId,
      } as never,
      { text: "hello from the inbox" },
    );
  return { dmCalls, profileLookups, send };
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
});
