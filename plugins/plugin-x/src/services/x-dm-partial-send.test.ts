/**
 * A DM longer than X's 10,000-character limit is sent in chunks. When X
 * refuses a later chunk, the real XService send paths must report the chunks
 * already in the conversation instead of a plain failure that a retry would
 * repeat. Only the X DM transport is recorded.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { XService } from "./x.service";

function harness(failOnCall: number) {
  const sent: string[] = [];
  let calls = 0;
  const session = {
    profile: { userId: "1000" },
    client: {
      v2: {
        sendDmToParticipant: async (
          _recipient: string,
          body: { text: string },
        ) => {
          calls += 1;
          if (calls === failOnCall)
            throw new Error("Request failed with code 429");
          sent.push(body.text);
          return { dm_event_id: `900${calls}` };
        },
      },
    },
  };
  const base = {
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
    getRoom: async () => null,
  } as unknown as IAgentRuntime;
  return { sent, service, runtime };
}

// Three chunks at the 10,000-character DM limit.
const LONG_DM = "a".repeat(25_000);

describe("long X DM that X refuses part way", () => {
  it("returns a partially delivered outcome with the sent message ids", async () => {
    const { sent, service, runtime } = harness(2);
    const outcome = await service.handleSendMessage(
      runtime,
      { source: "x", channelId: "2000" } as never,
      { text: LONG_DM },
    );
    expect(sent).toHaveLength(1);
    expect(outcome).toMatchObject({
      kind: "partially_delivered",
      code: "X_DM_PARTIALLY_SENT",
      receipt: { providerMessageIds: ["9001"] },
    });
  });

  it("returns a delivered outcome with every message id when all chunks are sent", async () => {
    const { sent, service, runtime } = harness(0);
    const outcome = await service.handleSendMessage(
      runtime,
      { source: "x", channelId: "2000" } as never,
      { text: LONG_DM },
    );
    expect(sent).toHaveLength(3);
    expect(outcome).toMatchObject({
      kind: "delivered",
      receipt: { providerMessageIds: ["9001", "9002", "9003"] },
    });
  });

  it("names the sent message ids when the assistant send fails part way", async () => {
    const { service } = harness(3);
    const error = await service
      .sendDirectMessageForAccount(undefined, {
        participantId: "2000",
        text: LONG_DM,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("X_DM_PARTIALLY_SENT");
    expect((error as ElizaError).context).toEqual({
      acceptedMessageIds: ["9001", "9002"],
    });
  });
});
