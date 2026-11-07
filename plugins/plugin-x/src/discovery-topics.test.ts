/**
 * Discovery acts on the character's topics (search, follow, like, reply), so it
 * must refuse to start when the character gives none, instead of running with an
 * empty topic list or with topics the operator never chose. The X service keeps
 * its other clients running and reports the refusal through `reportError`.
 */
import { ElizaError, type IAgentRuntime, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import { TwitterDiscoveryClient } from "./discovery";
import { TwitterClientInstance } from "./services/x.service";
import type { TwitterClientState } from "./types";

function createRuntime(
  character: Record<string, unknown>,
  settings: Record<string, string> = {},
) {
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa" as UUID,
    character: { name: "Agent", templates: {}, ...character },
    getSetting: vi.fn((key: string) => settings[key]),
    reportError: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return runtime as unknown as IAgentRuntime & typeof runtime;
}

function createDiscovery(runtime: IAgentRuntime) {
  const client = {
    accountId: "default",
    runtime,
    twitterClient: {},
  } as unknown as ClientBase;
  return new TwitterDiscoveryClient(
    client,
    runtime,
    {} as unknown as TwitterClientState,
  );
}

function configuredTopics(discovery: TwitterDiscoveryClient): string[] {
  return (discovery as unknown as { config: { topics: string[] } }).config
    .topics;
}

const SERVICE_SETTINGS = {
  TWITTER_ENABLE_DISCOVERY: "true",
  TWITTER_ENABLE_REPLIES: "false",
  TWITTER_ENABLE_DMS: "false",
};

describe("X discovery topics", () => {
  it("refuses to start when the bio gives no topics", () => {
    const runtime = createRuntime({ bio: "I am a cat", topics: [] });

    let thrown: unknown;
    try {
      createDiscovery(runtime);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ElizaError);
    expect((thrown as ElizaError).code).toBe("X_DISCOVERY_NO_TOPICS");
    expect((thrown as Error).message).toContain(
      "Set `topics` on the character",
    );
    expect((thrown as Error).message).toContain(
      "TWITTER_ENABLE_DISCOVERY=false",
    );
  });

  it("refuses to start when the character has neither topics nor a bio", () => {
    const runtime = createRuntime({});

    expect(() => createDiscovery(runtime)).toThrow(
      expect.objectContaining({ code: "X_DISCOVERY_NO_TOPICS" }),
    );
  });

  it("starts with the character's own topics", () => {
    const topics = ["rust", "zero-knowledge proofs", "compilers"];
    const runtime = createRuntime({
      bio: ["Systems engineer who writes about compilers and proof systems."],
      topics,
    });

    expect(configuredTopics(createDiscovery(runtime))).toEqual(topics);
  });

  it("keeps the X service up without discovery and reports the refusal", () => {
    const runtime = createRuntime(
      { bio: "I am a cat", topics: [] },
      SERVICE_SETTINGS,
    );

    const instance = new TwitterClientInstance(runtime, {
      accountId: "default",
    } as unknown as TwitterClientState);

    expect(instance.discovery).toBeUndefined();
    expect(runtime.reportError).toHaveBeenCalledTimes(1);
    expect(runtime.reportError).toHaveBeenCalledWith(
      "XDiscoveryClient.start",
      expect.objectContaining({ code: "X_DISCOVERY_NO_TOPICS" }),
    );
  });

  it("creates discovery in the X service when the character has topics", () => {
    const runtime = createRuntime(
      { bio: "I am a cat", topics: ["cats", "naps"] },
      SERVICE_SETTINGS,
    );

    const instance = new TwitterClientInstance(runtime, {
      accountId: "default",
    } as unknown as TwitterClientState);

    expect(instance.discovery).toBeInstanceOf(TwitterDiscoveryClient);
    expect(runtime.reportError).not.toHaveBeenCalled();
  });
});

describe("discovery count settings", () => {
  it("preserves an explicit zero for follow and engagement limits", () => {
    const discovery = createDiscovery(
      createRuntime(
        { topics: ["software"] },
        {
          TWITTER_MIN_FOLLOWER_COUNT: "0",
          TWITTER_MAX_FOLLOWS_PER_CYCLE: "0",
          TWITTER_MAX_ENGAGEMENTS_PER_RUN: "0",
        },
      ),
    );
    expect((discovery as unknown as { config: unknown }).config).toMatchObject({
      minFollowerCount: 0,
      maxFollowsPerCycle: 0,
      maxEngagementsPerCycle: 0,
    });
  });
  it.each(["3cats", "-1", "1.5", "9007199254740992"])(
    "rejects malformed count %s",
    (value) => {
      expect(() =>
        createDiscovery(
          createRuntime(
            { topics: ["software"] },
            {
              TWITTER_MAX_ENGAGEMENTS_PER_RUN: value,
            },
          ),
        ),
      ).toThrowError(
        expect.objectContaining({ code: "X_INVALID_COUNT_SETTING" }),
      );
    },
  );
});
