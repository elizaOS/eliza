/** Exercises discovery-cycle session binding and fail-closed read behavior with deterministic provider fakes. */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { ClientBase, TwitterAccountSession } from "./base";
import { TwitterDiscoveryClient } from "./discovery";
import type { TwitterClientState } from "./types";

type DiscoveryHarness = {
  runDiscoveryCycle(): Promise<void>;
  discoverContent(): Promise<{ tweets: unknown[]; accounts: unknown[] }>;
  discoverFromTopics(): Promise<{ tweets: unknown[]; accounts: unknown[] }>;
  processAccounts(
    accounts: unknown[],
    session: TwitterAccountSession,
  ): Promise<number>;
  processTweets(
    tweets: unknown[],
    session: TwitterAccountSession,
  ): Promise<number>;
};

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-1",
    character: { name: "Agent", topics: ["agents"] },
    getSetting: () => undefined,
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function makeClient(current: () => boolean): {
  client: ClientBase;
  session: TwitterAccountSession;
  withAuthenticatedSession: ReturnType<typeof vi.fn>;
} {
  const profile = {
    id: "account-a",
    username: "account-a",
    screenName: "Account A",
    bio: "",
    nicknames: [],
  };
  const api = {};
  const session = { client: api as never, profile, revision: 1 };
  const withAuthenticatedSession = vi.fn(
    async (operation: (value: TwitterAccountSession) => Promise<unknown>) =>
      operation(session),
  );
  return {
    client: {
      accountId: "default",
      twitterClient: api,
      withAuthenticatedSession,
      isAuthenticatedSessionCurrent: vi.fn(() => current()),
    } as unknown as ClientBase,
    session,
    withAuthenticatedSession,
  };
}

describe("TwitterDiscoveryClient session integrity", () => {
  it("keeps the read and both processing phases in one authenticated session", async () => {
    let depth = 0;
    const { client, session, withAuthenticatedSession } = makeClient(
      () => true,
    );
    withAuthenticatedSession.mockImplementation(
      async (operation: (value: TwitterAccountSession) => Promise<unknown>) => {
        depth += 1;
        try {
          return await operation(session);
        } finally {
          depth -= 1;
        }
      },
    );
    const discovery = new TwitterDiscoveryClient(
      client,
      makeRuntime(),
      {} as TwitterClientState,
    ) as unknown as DiscoveryHarness;
    vi.spyOn(discovery, "discoverContent").mockImplementation(async () => {
      expect(depth).toBe(1);
      return { tweets: [], accounts: [] };
    });
    vi.spyOn(discovery, "processAccounts").mockImplementation(
      async (_accounts, captured) => {
        expect(depth).toBe(1);
        expect(captured).toBe(session);
        return 0;
      },
    );
    vi.spyOn(discovery, "processTweets").mockImplementation(
      async (_tweets, captured) => {
        expect(depth).toBe(1);
        expect(captured).toBe(session);
        return 0;
      },
    );

    await discovery.runDiscoveryCycle();

    expect(withAuthenticatedSession).toHaveBeenCalledOnce();
    expect(depth).toBe(0);
  });

  it("aborts after a delayed read when the credential generation rotated", async () => {
    let current = true;
    let releaseRead!: () => void;
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const { client } = makeClient(() => current);
    const discovery = new TwitterDiscoveryClient(
      client,
      makeRuntime(),
      {} as TwitterClientState,
    ) as unknown as DiscoveryHarness;
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    vi.spyOn(discovery, "discoverContent").mockImplementation(async () => {
      readStarted();
      await readBlocked;
      return { tweets: [], accounts: [] };
    });
    const processAccounts = vi.spyOn(discovery, "processAccounts");
    const processTweets = vi.spyOn(discovery, "processTweets");

    const cycle = discovery.runDiscoveryCycle();
    await started;
    current = false;
    releaseRead();

    await expect(cycle).rejects.toMatchObject({
      code: "X_AUTH_SESSION_ROTATED",
    });
    expect(processAccounts).not.toHaveBeenCalled();
    expect(processTweets).not.toHaveBeenCalled();
  });

  it("surfaces a failed discovery source instead of returning zero work", async () => {
    const { client } = makeClient(() => true);
    const discovery = new TwitterDiscoveryClient(
      client,
      makeRuntime(),
      {} as TwitterClientState,
    ) as unknown as DiscoveryHarness;
    vi.spyOn(discovery, "discoverFromTopics").mockRejectedValue(
      new Error("provider unavailable"),
    );

    await expect(discovery.discoverContent()).rejects.toMatchObject({
      code: "X_DISCOVERY_READ_FAILED",
    });
  });
});
