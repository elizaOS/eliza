/**
 * An X direct message whose send X did not confirm is not sent again on the
 * next confirmation: the adapter looks the account's own sent messages up
 * first and returns the delivered event as the receipt.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { XDmAdapter } from "./lifeops-message-adapter";

function harness(delivered: boolean) {
  const sendDirectMessageForAccount = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    )
    .mockResolvedValue({
      ok: true,
      status: 201,
      messageId: "e-second",
      messageIds: ["e-second"],
    });
  const fetchDirectMessagesForAccount = vi.fn(async () =>
    delivered
      ? [
          {
            id: "m1",
            entityId: "agent",
            roomId: "conv-1",
            createdAt: Date.now() + 1,
            content: { text: "Running late, sorry!" },
            metadata: { x: { dmEventId: "e-first", conversationId: "conv-1" } },
          },
        ]
      : [],
  );
  const xService = {
    sendDirectMessageForAccount,
    fetchDirectMessagesForAccount,
  };
  const runtime = {
    agentId: "agent",
    getService: (name: string) => (name === "x" ? xService : null),
  } as unknown as IAgentRuntime;
  return {
    adapter: new XDmAdapter(),
    runtime,
    sendDirectMessageForAccount,
    fetchDirectMessagesForAccount,
  };
}

async function confirmTwice(delivered: boolean) {
  const {
    adapter,
    runtime,
    sendDirectMessageForAccount,
    fetchDirectMessagesForAccount,
  } = harness(delivered);
  const { draftId } = await adapter.createDraft(runtime, {
    source: "twitter",
    to: [{ identifier: "12345" }],
    body: "Running late, sorry!",
  });
  const first = await adapter.sendDraft(runtime, draftId).then(
    () => "sent",
    (error: unknown) => (error as { code?: string }).code,
  );
  const second = await adapter.sendDraft(runtime, draftId);
  return {
    first,
    second: second.externalId,
    sends: sendDirectMessageForAccount.mock.calls.length,
    lookups: fetchDirectMessagesForAccount.mock.calls.length,
  };
}

it("returns the delivered message instead of sending again", async () => {
  expect(await confirmTwice(true)).toEqual({
    first: "X_DM_SEND_OUTCOME_UNKNOWN",
    second: "e-first",
    sends: 1,
    lookups: 1,
  });
});

it("sends once more when X has no such message", async () => {
  expect(await confirmTwice(false)).toEqual({
    first: "X_DM_SEND_OUTCOME_UNKNOWN",
    second: "e-second",
    sends: 2,
    lookups: 1,
  });
});

it("reports a refusal as before and lets the owner send again", async () => {
  const {
    adapter,
    runtime,
    sendDirectMessageForAccount,
    fetchDirectMessagesForAccount,
  } = harness(true);
  sendDirectMessageForAccount
    .mockReset()
    .mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { code: 403 }))
    .mockResolvedValue({
      ok: true,
      status: 201,
      messageId: "e-second",
      messageIds: ["e-second"],
    });
  const { draftId } = await adapter.createDraft(runtime, {
    source: "twitter",
    to: [{ identifier: "12345" }],
    body: "Running late, sorry!",
  });
  await expect(adapter.sendDraft(runtime, draftId)).rejects.toThrow(
    "Forbidden",
  );
  await expect(adapter.sendDraft(runtime, draftId)).resolves.toEqual({
    externalId: "e-second",
  });
  expect(fetchDirectMessagesForAccount).not.toHaveBeenCalled();
});
