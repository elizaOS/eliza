/**
 * A Slack reply is one dialogue row. The assistant stores its reply under the
 * response id; the connector's delivery record must land on that same row (with
 * the Slack ts in its metadata) instead of adding a second row, or every later
 * prompt renders the reply twice. A reaction on the delivered reply still has
 * to resolve to that row.
 * Real account policy, connector entrypoints, assistant and PGlite runtime; only
 * the Slack WebClient and the model are fixtures.
 */
import { ModelType } from "@elizaos/core";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { SlackEventTypes, SlackService } from "@elizaos/plugin-slack";
import {
  createTestRuntimeWithModelProvider,
  type ModelProviderTestRuntime,
} from "@elizaos/testing/runtime";
import { afterEach, expect, it } from "vitest";
import { resolveSlackAccount } from "../src/accounts.ts";
import {
  SlackAccountPolicyResolver,
  type SlackPolicyDirectoryClient,
} from "../src/policy.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: ModelProviderTestRuntime): ModelProviderTestRuntime {
  cleanups.push(harness.cleanup);
  return harness;
}

// Realistic Slack identifiers that pass the connector's own validators
// (isValidChannelId / isValidUserId / isValidMessageTs).
const ACCOUNT_ID = "default";
const CHANNEL_ID = "D09DMCHAN01";
const USER_ID = "U09USER01";
const BOT_USER_ID = "U09BOT0001";
const TEAM_ID = "T09TEAM001";
const FIRST_TS = "1746810420.000300";
const SECOND_TS = "1746810600.000100";
const REPLY_TS = "1746810421.000400";
const REPLY_PART_TWO_TS = "1746810421.000500";
const LATER_REPLY_TS = "1746810601.000400";

/** Real runtime + real Slack connector for one DM; replies come from `replies`. */
async function createDmHarness(replies: string[]) {
  const prompts: string[] = [];
  const harness = track(
    await createTestRuntimeWithModelProvider({
      plugins: [createAssistantPlugin()],
      fixtures: [
        {
          name: "slack-dm-reply",
          match: { modelType: ModelType.RESPONSE_HANDLER },
          times: replies.length,
          response: (call) => {
            prompts.push(JSON.stringify(call.params));
            return {
              contexts: ["simple"],
              intents: [],
              replyText: replies[prompts.length - 1] ?? "",
              candidateActionNames: [],
            };
          },
        },
      ],
    }),
  );
  const { runtime } = harness;

  // The ONLY mocked surface: the external Slack SDK WebClient boundary.
  // Each chat.postMessage call returns the next ts in order.
  const deliveredTs = [REPLY_TS, REPLY_PART_TWO_TS, LATER_REPLY_TS];
  const delivered: Array<{ channel: string; text: string; ts: string }> = [];
  const captureClient = {
    chat: {
      postMessage: async (args: {
        channel: string;
        text: string;
        thread_ts?: string;
      }): Promise<{ ok: true; ts: string; channel: string }> => {
        const ts = deliveredTs[delivered.length] as string;
        delivered.push({ channel: args.channel, text: args.text, ts });
        return { ok: true, ts, channel: args.channel };
      },
    },
    users: {
      info: async (args: { user: string }) => ({
        ok: true,
        user: {
          id: args.user,
          team_id: TEAM_ID,
          name: "tester",
          real_name: "Tester McTest",
          profile: { display_name: "Tester", real_name: "Tester McTest" },
        },
      }),
    },
    conversations: {
      info: async (args: { channel: string }) => ({
        ok: true,
        channel: { id: args.channel, is_im: true, user: USER_ID, created: 1 },
      }),
    },
  };

  const settings = {
    allowedChannelIds: undefined,
    shouldIgnoreBotMessages: false,
    shouldRespondOnlyToMentions: false,
  };

  // Compile the same account policy used at connector startup.
  runtime.character.settings.slack = {
    dm: { policy: "open", allowFrom: ["*"] },
  };
  const account = resolveSlackAccount(runtime);
  const policy = await SlackAccountPolicyResolver.create({
    account,
    client: captureClient as unknown as SlackPolicyDirectoryClient,
    workspace: { teamId: TEAM_ID, botUserId: BOT_USER_ID },
    checkPairing: async () => {
      throw new Error("Open DM policy must not request pairing");
    },
  });
  const accountState = {
    accountId: ACCOUNT_ID,
    account,
    policy,
    client: captureClient,
    userClient: null,
    botUserId: BOT_USER_ID,
    teamId: TEAM_ID,
    settings,
    allowedChannelIds: new Set<string>(),
    dynamicChannelIds: new Set<string>(),
    userCache: new Map(),
    channelCache: new Map(),
    isConnected: true,
  };

  const service = Object.assign(
    Object.create(SlackService.prototype) as SlackService,
    {
      runtime,
      settings,
      defaultAccountId: ACCOUNT_ID,
      allowedChannelIds: new Set<string>(),
      dynamicChannelIds: new Set<string>(),
      userCache: new Map(),
      channelCache: new Map(),
      client: captureClient,
      botUserId: BOT_USER_ID,
      teamId: TEAM_ID,
      accountStates: new Map([[ACCOUNT_ID, accountState]]),
    },
  );
  const internals = service as unknown as {
    handleMessage: (
      message: Record<string, unknown>,
      client: typeof captureClient,
      accountId?: string,
      body?: unknown,
    ) => Promise<void>;
    handleReaction: (
      event: Record<string, unknown>,
      action: "added" | "removed",
      accountId: string,
      workspace: { teamId?: string },
    ) => Promise<void>;
    getRoomId: (
      channelId: string,
      threadTs: string | undefined,
      accountId: string,
    ) => Promise<Parameters<typeof runtime.getMemories>[0]["roomId"]>;
  };

  const dm = (text: string, ts: string, eventId: string) =>
    internals.handleMessage(
      {
        type: "message",
        channel: CHANNEL_ID,
        channel_type: "im",
        user: USER_ID,
        text,
        ts,
      },
      captureClient,
      ACCOUNT_ID,
      { team_id: TEAM_ID, event_id: eventId },
    );

  const agentRows = async () => {
    const roomId = await internals.getRoomId(CHANNEL_ID, undefined, ACCOUNT_ID);
    return (
      await runtime.getMemories({ tableName: "messages", roomId, count: 50 })
    ).filter((memory) => memory.entityId === runtime.agentId);
  };

  // Resolves to the stored row the reaction was attached to (its inReplyTo
  // and slackReaction.targetMessageId), via the real reaction entrypoint.
  const reactionTargets: Array<{ inReplyTo?: string; targetId?: unknown }> = [];
  runtime.registerEvent(
    SlackEventTypes.REACTION_ADDED as string,
    async (payload: {
      message: { content: { inReplyTo?: string }; metadata?: unknown };
    }) => {
      const meta = payload.message.metadata as {
        slackReaction?: { targetMessageId?: unknown };
      };
      reactionTargets.push({
        inReplyTo: payload.message.content.inReplyTo,
        targetId: meta?.slackReaction?.targetMessageId,
      });
    },
  );
  const reactTo = async (ts: string) => {
    await internals.handleReaction(
      {
        type: "reaction_added",
        user: USER_ID,
        reaction: "thumbsup",
        item: { type: "message", channel: CHANNEL_ID, ts },
        item_user: BOT_USER_ID,
        event_ts: "1746810700.000100",
      },
      "added",
      ACCOUNT_ID,
      { teamId: TEAM_ID },
    );
    return reactionTargets.pop();
  };

  return { prompts, delivered, dm, agentRows, reactTo };
}

it("stores a DM reply once, renders it once, and resolves a reaction on it", async () => {
  const h = await createDmHarness(["Bonjour.", "Buenos dias."]);

  await h.dm("Translate 'good morning' into French.", FIRST_TS, "Ev09DM0001");
  expect(h.delivered.map((d) => d.text)).toEqual(["Bonjour."]);

  // One DM turn leaves exactly one agent reply row in the DM room, and that
  // row carries the Slack ts the reply was delivered under.
  const rows = await h.agentRows();
  expect.soft(rows.map((memory) => memory.content.text)).toEqual(["Bonjour."]);
  expect
    .soft((rows[0]?.metadata as Record<string, unknown>)?.slackMessageTs)
    .toBe(REPLY_TS);

  // The next turn is planned from a transcript that shows the reply once:
  // every transcript copy in the prompt pairs the question with one answer.
  await h.dm("Now into Spanish.", SECOND_TS, "Ev09DM0002");
  expect(h.prompts).toHaveLength(2);
  const count = (needle: string) =>
    (h.prompts[1] ?? "").split(needle).length - 1;
  expect(count("into French.")).toBeGreaterThan(0);
  expect.soft(count(": Bonjour.")).toBe(count("into French."));

  // A reaction on the delivered reply resolves to that same stored row.
  expect(await h.reactTo(REPLY_TS)).toEqual({
    inReplyTo: rows[0]?.id,
    targetId: rows[0]?.id,
  });
}, 120_000);

it("keeps a reply sent as several Slack messages as one row every part resolves to", async () => {
  // Over MAX_SLACK_MESSAGE_LENGTH, so the connector posts it in two parts.
  const longReply = `${"alpha ".repeat(4_000).trim()}\n\n${"omega ".repeat(4_000).trim()}`;
  const h = await createDmHarness([longReply]);

  await h.dm("Write me a long poem.", FIRST_TS, "Ev09DM0003");
  expect(h.delivered.map((d) => d.ts)).toEqual([REPLY_TS, REPLY_PART_TWO_TS]);

  const rows = await h.agentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.content.text).toBe(longReply);
  expect(
    (rows[0]?.metadata as Record<string, unknown>)?.slackMessageTsList,
  ).toEqual([REPLY_TS, REPLY_PART_TWO_TS]);

  for (const ts of [REPLY_TS, REPLY_PART_TWO_TS]) {
    expect(await h.reactTo(ts)).toEqual({
      inReplyTo: rows[0]?.id,
      targetId: rows[0]?.id,
    });
  }
}, 120_000);
