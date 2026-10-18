/**
 * A long POST action=send reaches XService.handleSendPost, which posts the
 * text as a thread. When X refuses a later chunk, the chunks already public
 * must be reported so a retry does not post the thread again.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { XService } from "./x.service";

function harness(failAtCall: number) {
  const sent: Array<{ text: string; inReplyTo?: string }> = [];
  const profile = { id: "42", username: "agent" };
  const session = { profile };
  const base = {
    accountId: "default",
    withAuthenticatedSession: (op: (s: unknown) => unknown) => op(session),
    isAuthenticatedSessionCurrent: () => true,
    twitterClient: {
      sendTweet: async (text: string, inReplyTo?: string) => {
        if (sent.length + 1 === failAtCall) {
          throw new Error("Request failed with code 429");
        }
        sent.push({ text, inReplyTo });
        return { data: { id: `100${sent.length}` } };
      },
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
  const text = `${"a".repeat(200)} ${"b".repeat(200)}`;
  const send = () => service.handleSendPost(runtime, { text });
  return { sent, send };
}

describe("X post connector thread send", () => {
  it("reports the tweets already public when a later chunk fails", async () => {
    const { sent, send } = harness(2);
    const error = await send().then(
      () => null,
      (e: unknown) => e,
    );
    expect(sent).toHaveLength(1);
    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("X_THREAD_PARTIALLY_POSTED");
    expect((error as ElizaError).context).toEqual({
      acceptedTweetIds: ["1001"],
    });
  });

  it("returns one memory per posted chunk, each a reply to the previous", async () => {
    const { sent, send } = harness(0);
    const memories = await send();
    expect(sent.map((s) => s.inReplyTo)).toEqual([undefined, "1001"]);
    expect(memories).toHaveLength(2);
  });
});
