/**
 * Slack connector target resolution must not report provider query failures as
 * "no matching channel or user".
 *
 * `resolveConnectorTargets` resolves a channel name or user handle across
 * candidate accounts. When Slack API calls fail (e.g. rate limit, auth failure,
 * network outage), the connector must propagate the error rather than
 * swallowing it and returning [] (which signals a legitimate empty match).
 */
import type { IAgentRuntime, MessageConnectorQueryContext, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { normalizeAccountId } from "./accounts.ts";
import { SlackService } from "./service.ts";
import type { SlackChannel, SlackUser } from "./types.ts";

const ACCOUNT_ID = "acct-1";

function createService(overrides?: {
  listChannels?: (
    options?: { types?: string; limit?: number },
    accountId?: string | null,
  ) => Promise<SlackChannel[]>;
  listAllConnectorUsers?: (accountId: string) => Promise<any[]>;
}) {
  const runtime = {
    agentId: "11111111-1111-4111-8111-111111111111" as UUID,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getRoom: vi.fn(async () => null),
  } as unknown as IAgentRuntime;

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
            client: {},
          },
        ],
      ]),
      getClientForAccount: vi.fn(() => ({})),
      getCandidateAccountIds: vi.fn(() => [ACCOUNT_ID]),
      listChannels: overrides?.listChannels ?? vi.fn(async () => []),
      listAllConnectorUsers:
        overrides?.listAllConnectorUsers ?? vi.fn(async () => []),
      buildConnectorChannelTarget:
        SlackService.prototype.buildConnectorChannelTarget,
      buildConnectorUserTarget:
        SlackService.prototype.buildConnectorUserTarget,
      dedupeConnectorTargets:
        SlackService.prototype.dedupeConnectorTargets,
    },
  );

  return { service, runtime };
}

describe("Slack connector target lookup", () => {
  it("propagates a rate-limited query when lookups fail instead of reporting no match", async () => {
    const rateLimited = Object.assign(new Error("Rate limit exceeded"), {
      code: "slack_webapi_platform_error",
      data: { error: "ratelimited" },
    });
    const { service } = createService({
      listChannels: vi.fn(async () => {
        throw rateLimited;
      }),
      listAllConnectorUsers: vi.fn(async () => {
        throw rateLimited;
      }),
    });

    await expect(
      service.resolveConnectorTargets(
        "general",
        {} as MessageConnectorQueryContext,
      ),
    ).rejects.toBe(rateLimited);
  });

  it("propagates an auth failure instead of reporting no match", async () => {
    const authError = Object.assign(new Error("Invalid auth"), {
      code: "slack_webapi_platform_error",
      data: { error: "invalid_auth" },
    });
    const { service } = createService({
      listChannels: vi.fn(async () => {
        throw authError;
      }),
      listAllConnectorUsers: vi.fn(async () => {
        throw authError;
      }),
    });

    await expect(
      service.resolveConnectorTargets(
        "general",
        {} as MessageConnectorQueryContext,
      ),
    ).rejects.toBe(authError);
  });

  it("still reports no match when queries succeed with zero matching channels or users", async () => {
    const { service } = createService({
      listChannels: vi.fn(async () => []),
      listAllConnectorUsers: vi.fn(async () => []),
    });

    await expect(
      service.resolveConnectorTargets(
        "nonexistent_target",
        {} as MessageConnectorQueryContext,
      ),
    ).resolves.toEqual([]);
  });

  it("returns matching channel target when channel query succeeds even if user query fails", async () => {
    const { service } = createService({
      listChannels: vi.fn(async () => [
        {
          id: "C123456",
          name: "general",
          isChannel: true,
          isGroup: false,
          isIm: false,
          isMpim: false,
          isPrivate: false,
          topic: { value: "" },
          purpose: { value: "" },
        } as SlackChannel,
      ]),
      listAllConnectorUsers: vi.fn(async () => {
        throw new Error("missing_scope: users:read");
      }),
    });

    const targets = await service.resolveConnectorTargets(
      "general",
      {} as MessageConnectorQueryContext,
    );
    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0].target.channelId).toBe("C123456");
  });

  it("propagates user query failure when channel query succeeds with zero matches", async () => {
    const scopeError = Object.assign(new Error("missing_scope: users:read"), {
      code: "slack_webapi_platform_error",
      data: { error: "missing_scope" },
    });
    const { service } = createService({
      listChannels: vi.fn(async () => []),
      listAllConnectorUsers: vi.fn(async () => {
        throw scopeError;
      }),
    });

    await expect(
      service.resolveConnectorTargets(
        "alice",
        {} as MessageConnectorQueryContext,
      ),
    ).rejects.toBe(scopeError);
  });

  it("propagates channel query failure when user query succeeds with zero matches", async () => {
    const channelError = Object.assign(new Error("ratelimited: conversations.list"), {
      code: "slack_webapi_platform_error",
      data: { error: "ratelimited" },
    });
    const { service } = createService({
      listChannels: vi.fn(async () => {
        throw channelError;
      }),
      listAllConnectorUsers: vi.fn(async () => []),
    });

    await expect(
      service.resolveConnectorTargets(
        "general",
        {} as MessageConnectorQueryContext,
      ),
    ).rejects.toBe(channelError);
  });
});
