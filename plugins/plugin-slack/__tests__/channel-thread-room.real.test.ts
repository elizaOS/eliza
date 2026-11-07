/**
 * A top-level message in a Slack channel is answered in a thread under it, and
 * the user keeps talking in that thread. The thread is its own room, and that
 * room's stored messages are the transcript the next turn in it is planned
 * from, so it must hold the question the thread started with, not only the
 * agent's answer.
 * Real account policy, connector entrypoint, assistant and PGlite runtime; only
 * the Slack WebClient and the model are fixtures.
 */
import { ModelType } from "@elizaos/core";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { SlackService } from "@elizaos/plugin-slack";
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
const CHANNEL_ID = "C09ABCD1234";
const USER_ID = "U09USER01";
const BOT_USER_ID = "U09BOT0001";
const TEAM_ID = "T09TEAM001";
const ROOT_TS = "1746810420.000300";
const FOLLOW_UP_TS = "1746810600.000100";

it("plans a thread follow-up with the channel question the thread answers", async () => {
  const prompts: string[] = [];
  const harness = track(
    await createTestRuntimeWithModelProvider({
      plugins: [createAssistantPlugin()],
      fixtures: [
        {
          name: "slack-thread-reply",
          match: { modelType: ModelType.RESPONSE_HANDLER },
          times: 2,
          response: (call) => {
            prompts.push(JSON.stringify(call.params));
            return {
              contexts: ["simple"],
              intents: [],
              replyText: prompts.length === 1 ? "Bonjour." : "Buenos dias.",
              candidateActionNames: [],
            };
          },
        },
      ],
    }),
  );
  const { runtime } = harness;

  // The ONLY mocked surface: the external Slack SDK WebClient boundary.
  // `chat.postMessage` is the outbound capture; `users.info` /
  // `conversations.info` back the connector's real getUser/getChannel.
  const delivered: Array<{ channel: string; text: string; ts: string }> = [];
  const captureClient = {
    chat: {
      postMessage: async (args: {
        channel: string;
        text: string;
        thread_ts?: string;
      }): Promise<{ ok: true; ts: string; channel: string }> => {
        const ts = ["1746810421.000400", "1746810601.000400"][
          delivered.length
        ] as string;
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
          profile: {
            display_name: "Tester",
            real_name: "Tester McTest",
          },
        },
      }),
    },
    conversations: {
      info: async (args: { channel: string }) => ({
        ok: true,
        channel: {
          id: args.channel,
          name: "general",
          is_channel: true,
          is_member: true,
          created: 1,
          creator: BOT_USER_ID,
        },
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
    groupPolicy: "allowlist",
    channels: { [CHANNEL_ID]: { requireMention: false } },
  };
  const account = resolveSlackAccount(runtime);
  const policy = await SlackAccountPolicyResolver.create({
    account,
    client: captureClient as unknown as SlackPolicyDirectoryClient,
    workspace: { teamId: TEAM_ID, botUserId: BOT_USER_ID },
    checkPairing: async () => {
      throw new Error("Channel flow must not request DM pairing");
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

  type Inbound = {
    type: "message";
    channel: string;
    channel_type: "channel";
    user: string;
    text: string;
    ts: string;
    thread_ts?: string;
  };
  const handleMessage = (event: Inbound, eventId: string) =>
    (
      service as unknown as {
        handleMessage: (
          message: Inbound,
          client: typeof captureClient,
          accountId?: string,
          body?: unknown,
        ) => Promise<void>;
      }
    ).handleMessage(event, captureClient, ACCOUNT_ID, {
      team_id: TEAM_ID,
      event_id: eventId,
    });

  // The question is posted at the top level of the channel.
  await handleMessage(
    {
      type: "message",
      channel: CHANNEL_ID,
      channel_type: "channel",
      user: USER_ID,
      text: "Translate 'good morning' into French.",
      ts: ROOT_TS,
    },
    "Ev09ROOT001",
  );
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.text).toBe("Bonjour.");

  // The user answers inside the reply thread Slack opened under the question.
  await handleMessage(
    {
      type: "message",
      channel: CHANNEL_ID,
      channel_type: "channel",
      user: USER_ID,
      text: "Now into Spanish.",
      ts: FOLLOW_UP_TS,
      thread_ts: ROOT_TS,
    },
    "Ev09FOLLOW01",
  );
  expect(delivered).toHaveLength(2);

  // The follow-up turn is planned from the thread's transcript, which must
  // still hold the question the thread is about.
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("Bonjour.");
  expect(prompts[1]).toContain("good morning");

  const roomIdFor = (threadTs: string | undefined) =>
    (
      service as unknown as {
        getRoomId: (
          channelId: string,
          threadTs: string | undefined,
          accountId: string,
        ) => Promise<Parameters<typeof runtime.getMemories>[0]["roomId"]>;
      }
    ).getRoomId(CHANNEL_ID, threadTs, ACCOUNT_ID);
  const textsIn = async (threadTs: string | undefined) =>
    (
      await runtime.getMemories({
        tableName: "messages",
        roomId: await roomIdFor(threadTs),
        count: 50,
      })
    )
      .map((memory) => memory.content.text ?? "")
      .reverse();

  // The thread's stored transcript opens with the question, then the answer.
  const threadTexts = await textsIn(ROOT_TS);
  expect(threadTexts[0]).toContain("Translate 'good morning' into French.");
  expect(threadTexts[1]).toBe("Bonjour.");
  expect(threadTexts).toContainEqual(
    expect.stringContaining("Now into Spanish."),
  );
  // The channel keeps its own record of the message as before.
  expect(await textsIn(undefined)).toContainEqual(
    expect.stringContaining("Translate 'good morning' into French."),
  );
}, 120_000);
