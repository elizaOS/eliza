/**
 * Exercises Slack message admission, persistence, and delivery with the real
 * account policy, connector methods, assistant, and PGlite runtime. Deterministic
 * model fixtures and captured SDK calls replace external services; this does not
 * exercise Socket Mode or Slack itself.
 */
import { ModelType } from "@elizaos/core";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { SlackService } from "@elizaos/plugin-slack";
import {
  createTestRuntimeWithModelProvider,
  type ModelProviderTestRuntime,
} from "@elizaos/testing";
import { afterEach, describe, expect, it } from "vitest";
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
const INBOUND_TS = "1746810420.000300";

describe("slack connector loop (keyless)", () => {
  it("drives a synthetic Slack message through the deterministic model provider to a delivered reply", async () => {
    const harness = track(
      await createTestRuntimeWithModelProvider({
        plugins: [createAssistantPlugin()],
        fixtures: [
          {
            name: "slack-reply",
            match: { modelType: ModelType.RESPONSE_HANDLER },
            response: {
              contexts: ["simple"],
              intents: [],
              replyText: "Hello from the deterministic model provider.",
              candidateActionNames: [],
            },
          },
        ],
      }),
    );
    const { runtime } = harness;

    // The ONLY mocked surface: the external Slack SDK WebClient boundary.
    // `chat.postMessage` is the outbound capture; `users.info` /
    // `conversations.info` back the connector's real getUser/getChannel.
    const delivered: Array<{ channel: string; text: string; ts?: string }> = [];
    const captureClient = {
      chat: {
        postMessage: async (args: {
          channel: string;
          text: string;
          thread_ts?: string;
        }): Promise<{ ok: true; ts: string; channel: string }> => {
          delivered.push({ channel: args.channel, text: args.text });
          return { ok: true, ts: "1746810421.000400", channel: args.channel };
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

    const inboundEvent = {
      type: "message",
      channel: CHANNEL_ID,
      channel_type: "channel",
      user: USER_ID,
      text: "Hello agent, please reply.",
      ts: INBOUND_TS,
    };

    // Invoke the REAL private connector entrypoint — the same method
    // `app.event("message", ...)` dispatches to in production. This runs
    // buildMemoryFromMessage, ensureRoomExists, processAgentMessage (deterministic model provider),
    // and sendMessage end-to-end.
    await (
      service as unknown as {
        handleMessage: (
          message: typeof inboundEvent,
          client: typeof captureClient,
          accountId?: string,
          body?: unknown,
        ) => Promise<void>;
      }
    ).handleMessage(inboundEvent, captureClient, ACCOUNT_ID, {
      team_id: TEAM_ID,
      event_id: "Ev09TEST001",
    });

    // The loop closed end-to-end through the real connector: the inbound Slack
    // event produced a non-empty outbound reply, delivered back to the inbound
    // channel via the captured WebClient, generated entirely by the
    // deterministic model provider with zero external cost.
    expect(
      delivered.length,
      "the connector delivered at least one outbound chat.postMessage",
    ).toBeGreaterThan(0);
    expect(
      delivered[0]?.text.trim().length,
      "the delivered reply carries text",
    ).toBeGreaterThan(0);
    expect(
      delivered[0]?.channel,
      "the reply went back to the inbound Slack channel",
    ).toBe(CHANNEL_ID);

    // The real inbound→Memory pipeline reconciled a room: ensureRoomExists
    // resolved the connector's own room id and persisted a room bound to the
    // inbound channel.
    const roomId = await (
      service as unknown as {
        getRoomId: (
          channelId: string,
          threadTs: string | undefined,
          accountId: string,
        ) => Promise<string>;
      }
    ).getRoomId(CHANNEL_ID, undefined, ACCOUNT_ID);
    const room = await runtime.getRoom(
      roomId as Parameters<typeof runtime.getRoom>[0],
    );
    expect(
      room?.channelId,
      "ensureRoomExists reconciled a room bound to the inbound channel",
    ).toBe(CHANNEL_ID);
  }, 60_000);
});
