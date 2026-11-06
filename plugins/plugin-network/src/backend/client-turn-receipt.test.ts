/**
 * One collected reply must carry one causal output id. The gateway sends the
 * service's `replyIds` back in the turn receipt, so a reply without its own id
 * would be delivered without a receipt that can name it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NetworkServiceClient, NetworkServiceError } from "./client.js";
import type { TurnRequest, TurnResponse } from "./contract.js";

const SECRET = "s".repeat(40);

const request: TurnRequest = {
  messageId: "msg_1",
  channel: "blooio",
  from: "+15550000001",
  to: null,
  text: "yes friday works",
  transport: "unknown",
  receivedAt: 1_760_000_000_000,
};

function handled(
  overrides: Partial<Extract<TurnResponse, { outcome: "handled" }>>,
) {
  return {
    outcome: "handled",
    replies: ["Your intro to Sam is set for Friday."],
    replyIds: ["reply_1"],
    delivery: "collected",
    replyKind: "reply",
    accountEligible: true,
    app: "slop",
    memberId: "member_1",
    reason: "intro_confirmed",
    ...overrides,
  };
}

function clientReturning(payload: unknown): NetworkServiceClient {
  return new NetworkServiceClient({
    baseUrl: "https://network.test",
    secret: SECRET,
    fetch: (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });
}

async function turnRejection(payload: unknown): Promise<unknown> {
  const client = clientReturning(payload);
  return client.turn(request).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("Network turn reply ids", () => {
  it("accepts one id for each collected reply", async () => {
    const response = await clientReturning(
      handled({
        replies: [
          "Your intro to Sam is set for Friday.",
          "Reply YES to confirm.",
        ],
        replyIds: ["reply_1", "reply_2"],
      }),
    ).turn(request);
    assert.equal(response.outcome, "handled");
    assert.equal(response.outcome === "handled" && response.replyIds.length, 2);
  });

  it("rejects a turn whose ids cover fewer replies than were collected", async () => {
    const error = await turnRejection(
      handled({
        replies: [
          "Your intro to Sam is set for Friday.",
          "Reply YES to confirm.",
        ],
        replyIds: ["reply_1"],
      }),
    );
    assert.ok(error instanceof NetworkServiceError);
    assert.match(error.message, /invalid turn response/);
  });

  it("rejects a blank causal id", async () => {
    const error = await turnRejection(handled({ replyIds: ["  "] }));
    assert.ok(error instanceof NetworkServiceError);
    assert.match(error.message, /invalid turn response/);
  });
});
