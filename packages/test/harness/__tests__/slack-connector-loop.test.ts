/**
 * Keyless Slack connector loop e2e (#8801, criterion 5).
 *
 * Unlike the generic {@link connector-loop.test.ts} (which drives
 * `runtime.messageService.handleMessage` directly), this exercises the Slack
 * connector's REAL code path. A synthetic inbound Slack `message` event goes
 * through `SlackService.handleMessage` — the same entrypoint the Socket Mode
 * `app.event("message", ...)` handler calls — which runs the connector's own
 * `buildMemoryFromMessage` (inbound → Memory mapping), `ensureRoomExists`
 * (room/world reconciliation), routes the turn through the deterministic mock
 * LLM via `processAgentMessage`, and delivers the agent's reply through the
 * connector's REAL outbound seam: `sendMessage` → `getOutboundClient` →
 * `client.chat.postMessage` (with mrkdwn conversion + chunking).
 *
 * Only the external Slack SDK boundary (`@slack/web-api` WebClient) is mocked —
 * a capture double whose `chat.postMessage` records the delivered reply and
 * whose `users.info` / `conversations.info` feed the real `getUser` /
 * `getChannel` lookups. No bot token, no app token, no Socket Mode, no network.
 */
import { SlackService } from "@elizaos/plugin-slack";
import { afterEach, describe, expect, it } from "vitest";
import { type MockLlmRuntime, withMockLlmRuntime } from "../index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: MockLlmRuntime): MockLlmRuntime {
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
  it("drives a synthetic Slack message through the mock LLM to a delivered reply", async () => {
    // Heuristic (non-strict) proxy: the reply turn makes several model calls;
    // let the proxy answer them deterministically without hand fixtures.
    const harness = track(await withMockLlmRuntime({ strict: false }));
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

    // The account-state shape the real per-account accessor methods read:
    // `getOutboundClient` (state.account.role !== "OWNER" → state.client),
    // `getClientForAccount` (state.client), `getSettingsForAccount`
    // (state.settings), `getBotUserIdForAccount` (state.botUserId),
    // `getTeamIdForAccount` (state.teamId), `isChannelAllowed`
    // (state.allowedChannelIds / state.dynamicChannelIds, both empty → allow),
    // and the per-account user/channel caches.
    const accountState = {
      accountId: ACCOUNT_ID,
      account: { accountId: ACCOUNT_ID, name: "Test", role: "AGENT" },
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
    // buildMemoryFromMessage, ensureRoomExists, processAgentMessage (mock LLM),
    // and sendMessage end-to-end.
    await (
      service as unknown as {
        handleMessage: (
          message: typeof inboundEvent,
          client: typeof captureClient,
          accountId?: string,
        ) => Promise<void>;
      }
    ).handleMessage(inboundEvent, captureClient, ACCOUNT_ID);

    // The loop closed end-to-end through the real connector: the inbound Slack
    // event produced a non-empty outbound reply, delivered back to the inbound
    // channel via the captured WebClient, generated entirely by the
    // deterministic mock LLM with zero external cost.
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
