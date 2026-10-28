/**
 * Slack's conversations.replies returns the parent first and then replies in
 * chronological order, paging forward in time. readThreadReplies must still
 * hand callers the newest `limit` rows newest-first, the same contract as
 * readHistory, so thread reads surface the latest replies.
 */
import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { normalizeAccountId } from "./accounts.ts";
import { SlackService } from "./service.ts";
import type { SlackChannel, SlackMessage } from "./types.ts";

const ACCOUNT_ID = "acct-1";
const CHANNEL_ID = "C12345678";
const THREAD_TS = "1";

type RepliesPage = {
  messages: Array<Record<string, unknown>>;
  response_metadata?: { next_cursor?: string };
};

// Recorded pages: parent ts=1, replies ts=2..6, oldest-first across two pages.
const recordedPages: Record<string, RepliesPage> = {
  first: {
    messages: ["1", "2", "3"].map((ts) => ({
      type: "message",
      ts,
      user: "U1",
      text: `msg ${ts}`,
      thread_ts: THREAD_TS,
    })),
    response_metadata: { next_cursor: "page-2" },
  },
  "page-2": {
    messages: ["4", "5", "6"].map((ts) => ({
      type: "message",
      ts,
      user: "U1",
      text: `msg ${ts}`,
      thread_ts: THREAD_TS,
    })),
  },
};

function createService() {
  const replies = vi.fn(
    async (args: { cursor?: string }) =>
      recordedPages[args.cursor ?? "first"] as RepliesPage,
  );
  const runtime = {
    agentId: "11111111-1111-4111-8111-111111111111" as UUID,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRoom: vi.fn(async () => null),
  } as unknown as IAgentRuntime;
  // Stub client: only conversations.replies is exercised.
  const service = Object.assign(
    Object.create(SlackService.prototype) as SlackService,
    {
      runtime,
      defaultAccountId: ACCOUNT_ID,
      accountStates: new Map([
        [
          normalizeAccountId(ACCOUNT_ID),
          {
            accountId: ACCOUNT_ID,
            account: { accountId: ACCOUNT_ID, name: "A" },
            teamId: "TA",
            botUserId: "B0AGENT",
            client: { conversations: { replies } },
          },
        ],
      ]),
      resolveAccountIdForTarget: vi.fn(async () => ACCOUNT_ID),
      getChannel: vi.fn(
        async () => ({ id: CHANNEL_ID, name: "general" }) as SlackChannel,
      ),
      getUser: vi.fn(async () => null),
    },
  );
  return { service, runtime, replies };
}

type ThreadReader = {
  readThreadReplies(
    channelId: string,
    threadTs: string,
    options?: { limit?: number },
    accountId?: string | null,
  ): Promise<SlackMessage[]>;
};

describe("Slack thread replies order", () => {
  it("keeps the newest replies newest-first when a limit is set", async () => {
    const { service, replies } = createService();
    const rows = await (service as unknown as ThreadReader).readThreadReplies(
      CHANNEL_ID,
      THREAD_TS,
      { limit: 3 },
      ACCOUNT_ID,
    );
    expect(rows.map((row) => row.ts)).toEqual(["6", "5", "4"]);
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("returns every row newest-first without a limit", async () => {
    const { service } = createService();
    const rows = await (service as unknown as ThreadReader).readThreadReplies(
      CHANNEL_ID,
      THREAD_TS,
      undefined,
      ACCOUNT_ID,
    );
    expect(rows.map((row) => row.ts)).toEqual(["6", "5", "4", "3", "2", "1"]);
  });
});
