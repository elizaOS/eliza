/**
 * TWITTER_DRY_RUN is a boolean setting. The connector reads TWITTER_ENABLE_POST
 * and the post client's own dry-run flag with core `parseBooleanFromText`, so
 * `1`, `yes` and `on` turn them on. The validated client state every X client
 * reads must keep dry run on for those values too; otherwise
 * `TWITTER_ENABLE_POST=1` with `TWITTER_DRY_RUN=1` posts for real. Real
 * runtime (SQLite), account resolution, settings validation, client instance
 * and post callback; only the X API client is stubbed.
 */
import { type AgentRuntime, logger, type UUID } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTwitterAccountConfig } from "./client/accounts";
import { validateTwitterConfig } from "./environment";
import { TwitterClientInstance } from "./services/x.service";
import { createTwitterPostCallback } from "./utils/twitter-post-callback";

beforeEach(() => {
  logger.log = vi.fn();
  logger.info = vi.fn();
  logger.warn = vi.fn();
  logger.error = vi.fn();
  logger.debug = vi.fn();
});

function runtimeWith(settings: Record<string, string>) {
  return createSQLiteTestRuntime({
    logLevel: "fatal",
    character: {
      name: "Agent",
      bio: ["test"],
      settings: {
        TWITTER_API_KEY: "key",
        TWITTER_API_SECRET_KEY: "secret",
        TWITTER_ACCESS_TOKEN: "token",
        TWITTER_ACCESS_TOKEN_SECRET: "token-secret",
        ...settings,
      },
    },
  });
}

/** The same resolve/validate sequence XService.start and getTwitterClientForAccount run. */
async function validatedState(runtime: AgentRuntime) {
  const defaultState = await resolveTwitterAccountConfig(runtime);
  const validatedDefault = {
    ...defaultState,
    ...(await validateTwitterConfig(runtime, defaultState)),
  };
  const state = await resolveTwitterAccountConfig(runtime, {
    accountId: "default",
    state: validatedDefault,
  });
  return { ...state, ...(await validateTwitterConfig(runtime, state)) };
}

describe("TWITTER_DRY_RUN", () => {
  it.each(["true", "1", "yes", "on", "TRUE"])(
    "keeps dry run on for %s",
    async (value) => {
      const state = await validatedState(
        runtimeWith({ TWITTER_DRY_RUN: value }),
      );
      expect(state.TWITTER_DRY_RUN).toBe("true");
    },
  );

  it.each(["false", "0", "no", "off"])(
    "keeps dry run off for %s",
    async (value) => {
      const state = await validatedState(
        runtimeWith({ TWITTER_DRY_RUN: value }),
      );
      expect(state.TWITTER_DRY_RUN).toBe("false");
    },
  );

  it("is off when unset", async () => {
    const state = await validatedState(runtimeWith({}));
    expect(state.TWITTER_DRY_RUN).toBe("false");
  });

  it("does not post a generated tweet when TWITTER_DRY_RUN=1", async () => {
    const runtime = runtimeWith({
      TWITTER_DRY_RUN: "1",
      TWITTER_ENABLE_POST: "1",
      TWITTER_ENABLE_REPLIES: "false",
      TWITTER_ENABLE_DMS: "false",
    });
    await runtime.initialize({ skipMigrations: true });
    try {
      const state = await validatedState(runtime);
      const instance = new TwitterClientInstance(runtime, state);
      // TWITTER_ENABLE_POST=1 already turns the post client on.
      expect(instance.post).toBeDefined();

      const posted: string[] = [];
      const v2 = {
        tweet: async (params: { text: string }) => {
          posted.push(params.text);
          return { data: { id: "1850000000000000777", text: params.text } };
        },
      };
      const session = {
        client: v2,
        revision: 1,
        profile: {
          userId: "bot-user",
          username: "bot",
          name: "Bot",
          biography: "",
        },
      };
      Object.assign(instance.client.twitterClient, {
        auth: {
          getV2Client: async () => ({ v2 }),
          getAuthenticatedSession: async () => session,
          withAuthenticatedSession: async (
            operation: (current: typeof session) => Promise<unknown>,
          ) => operation(session),
          withCurrentSession: async (
            _current: typeof session,
            operation: () => Promise<unknown>,
          ) => operation(),
          isAuthenticatedSessionCurrent: () => true,
        },
      });

      // TwitterPostClient builds this callback from the same validated state.
      const callback = createTwitterPostCallback({
        client: instance.client,
        runtime,
        state,
        roomId: "00000000-0000-0000-0000-00000000a001" as UUID,
        userId: "bot-user",
        username: "bot",
      });
      await callback({ text: "gm builders, shipping a small fix today" });

      expect(posted).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });
});

describe("TWITTER_ENABLE_REPLIES", () => {
  it.each(["false", "FALSE", "0", "no", "off"])(
    "turns mention and reply handling off for %s",
    async (value) => {
      const runtime = runtimeWith({
        TWITTER_ENABLE_REPLIES: value,
        TWITTER_ENABLE_DMS: "false",
      });
      await runtime.initialize({ skipMigrations: true });
      try {
        const state = await validatedState(runtime);
        expect(state.TWITTER_ENABLE_REPLIES).toBe("false");
        expect(
          new TwitterClientInstance(runtime, state).interaction,
        ).toBeUndefined();
      } finally {
        await runtime.stop();
      }
    },
  );

  it.each(["true", "1", "yes", "on"])(
    "keeps mention and reply handling on for %s",
    async (value) => {
      const runtime = runtimeWith({
        TWITTER_ENABLE_REPLIES: value,
        TWITTER_ENABLE_DMS: "false",
      });
      await runtime.initialize({ skipMigrations: true });
      try {
        const state = await validatedState(runtime);
        expect(state.TWITTER_ENABLE_REPLIES).toBe("true");
        expect(
          new TwitterClientInstance(runtime, state).interaction,
        ).toBeDefined();
      } finally {
        await runtime.stop();
      }
    },
  );
});
