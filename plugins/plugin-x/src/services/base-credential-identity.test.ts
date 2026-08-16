/** Deterministic tests for credential-bound X identity publication and cursor migration. */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientBase, type TwitterProfile } from "../base";
import type { TwitterClientState } from "../types";

type RawProfile = {
  userId: string;
  username: string;
  name: string;
  biography: string;
};

const CURRENT_PROFILE: TwitterProfile = {
  id: "account-b",
  username: "current-b",
  screenName: "Current B",
  bio: "",
  nicknames: [],
};

function asRuntime<T extends object>(runtime: T): IAgentRuntime & T {
  return runtime as IAgentRuntime & T;
}

function attachRawSession(
  base: ClientBase,
  profile: RawProfile,
  options: {
    apiClient?: object;
    revision?: number;
    isCurrent?: () => boolean;
  } = {},
): void {
  const apiClient = options.apiClient ?? {};
  const revision = options.revision ?? 1;
  base.twitterClient = {
    withAuthenticatedSession: vi.fn(
      async (
        operation: (session: {
          client: object;
          profile: RawProfile;
          revision: number;
        }) => Promise<unknown>,
      ) => operation({ client: apiClient, profile, revision }),
    ),
    withCurrentSession: vi.fn(
      async (_session: unknown, operation: () => Promise<unknown>) =>
        operation(),
    ),
    isAuthenticatedSessionCurrent: vi.fn(options.isCurrent ?? (() => true)),
  } as unknown as ClientBase["twitterClient"];
}

afterEach(() => vi.restoreAllMocks());

describe("ClientBase authenticated identity", () => {
  it("publishes only the default account while a secondary account keeps local identity and cursor state", async () => {
    let entity = {
      id: "agent-1",
      names: ["Agent"],
      metadata: {},
      agentId: "agent-1",
    };
    const getEntityById = vi.fn(async () => entity);
    const updateEntity = vi.fn(async (next: typeof entity) => {
      entity = next;
    });
    const getCache = vi.fn(async (key: string) =>
      key === "twitter/secondary/secondary-user/latest_checked_tweet_id"
        ? "88"
        : undefined,
    );
    const runtime = asRuntime({
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      getEntityById,
      updateEntity,
      getCache,
      setCache: vi.fn(),
    });

    const defaultClient = new ClientBase(runtime, {
      accountId: "default",
    } as TwitterClientState);
    attachRawSession(defaultClient, {
      userId: "default-user",
      username: "default-name",
      name: "Default Name",
      biography: "default bio",
    });
    await expect(
      defaultClient.getAuthenticatedProfile(),
    ).resolves.toMatchObject({ id: "default-user", username: "default-name" });
    expect(getEntityById).toHaveBeenCalledOnce();
    expect(updateEntity).toHaveBeenCalledOnce();
    expect(entity).toMatchObject({
      metadata: {
        twitter: {
          id: "default-user",
          userName: "default-name",
          name: "Default Name",
        },
      },
    });

    getEntityById.mockClear();
    updateEntity.mockClear();
    const secondaryClient = new ClientBase(
      runtime,
      { accountId: "secondary" } as TwitterClientState,
      { publishLegacyIdentity: false },
    );
    attachRawSession(secondaryClient, {
      userId: "secondary-user",
      username: "secondary-name",
      name: "Secondary Name",
      biography: "secondary bio",
    });

    await expect(
      secondaryClient.getAuthenticatedProfile(),
    ).resolves.toMatchObject({
      id: "secondary-user",
      username: "secondary-name",
    });
    expect(secondaryClient.profile).toMatchObject({ id: "secondary-user" });
    expect(secondaryClient.lastCheckedTweetId).toBe(88n);
    expect(getEntityById).not.toHaveBeenCalled();
    expect(updateEntity).not.toHaveBeenCalled();
    expect(getCache).toHaveBeenCalledWith(
      "twitter/secondary/secondary-user/latest_checked_tweet_id",
    );
    expect(defaultClient.identityCacheKey(CURRENT_PROFILE, "cursor")).toBe(
      "twitter/default/account-b/cursor",
    );
    expect(secondaryClient.identityCacheKey(CURRENT_PROFILE, "cursor")).toBe(
      "twitter/secondary/account-b/cursor",
    );
  });

  it("migrates a same-user cursor from the prior username into the canonical account-and-id key", async () => {
    const canonicalKey = "twitter/default/same-user/latest_checked_tweet_id";
    const legacyKey = "twitter/old-name/latest_checked_tweet_id";
    const entity = {
      id: "agent-1",
      names: ["Agent", "Old Name", "old-name"],
      metadata: {
        twitter: {
          id: "same-user",
          userName: "old-name",
          name: "Old Name",
        },
      },
      agentId: "agent-1",
    };
    const getCache = vi.fn(async (key: string) =>
      key === legacyKey ? "42" : undefined,
    );
    const setCache = vi.fn();
    const runtime = asRuntime({
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      getEntityById: vi.fn(async () => entity),
      updateEntity: vi.fn(),
      getCache,
      setCache,
    });
    const client = new ClientBase(runtime, {
      accountId: "default",
    } as TwitterClientState);
    attachRawSession(client, {
      userId: "same-user",
      username: "new-name",
      name: "New Name",
      biography: "",
    });

    await client.getAuthenticatedProfile();

    expect(getCache).toHaveBeenCalledWith(canonicalKey);
    expect(getCache).toHaveBeenCalledWith(legacyKey);
    expect(setCache).toHaveBeenCalledWith(canonicalKey, "42");
    expect(client.lastCheckedTweetId).toBe(42n);
  });

  it("clears its compatibility profile after any authenticated refresh failure", async () => {
    const entity = {
      id: "agent-1",
      names: ["Agent", "Current B", "current-b"],
      metadata: {
        twitter: {
          id: "account-b",
          userName: "current-b",
          name: "Current B",
        },
      },
      agentId: "agent-1",
    };
    const runtime = asRuntime({
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      getEntityById: vi.fn(async () => entity),
      updateEntity: vi.fn(),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(),
    });
    const client = new ClientBase(runtime, {
      accountId: "default",
    } as TwitterClientState);
    attachRawSession(client, {
      userId: "account-b",
      username: "current-b",
      name: "Current B",
      biography: "",
    });
    await client.getAuthenticatedProfile();
    expect(client.profile).toMatchObject({ id: "account-b" });

    const refreshFailure = new ElizaError("profile provider unavailable", {
      code: "X_ME_FETCH_FAILED",
    });
    client.twitterClient.withAuthenticatedSession = vi.fn(async () => {
      throw refreshFailure;
    });

    await expect(client.getAuthenticatedProfile()).rejects.toBe(refreshFailure);
    expect(client.profile).toBeNull();
  });

  it("does not publish a new account after durable identity metadata fails to update", async () => {
    const entity = {
      id: "agent-1",
      names: ["Agent", "Account A", "account-a"],
      metadata: {
        twitter: {
          id: "account-a",
          userName: "account-a",
          name: "Account A",
        },
      },
      agentId: "agent-1",
    };
    const updateFailure = new Error("entity store unavailable");
    const runtime = asRuntime({
      agentId: "agent-1",
      character: { name: "Agent" },
      getSetting: () => undefined,
      getEntityById: vi.fn(async () => entity),
      updateEntity: vi.fn(async () => {
        throw updateFailure;
      }),
      getCache: vi.fn(async () => undefined),
      setCache: vi.fn(),
    });
    const client = new ClientBase(runtime, {
      accountId: "default",
    } as TwitterClientState);
    attachRawSession(client, {
      userId: "account-b",
      username: "account-b",
      name: "Account B",
      biography: "B",
    });

    await expect(client.getAuthenticatedProfile()).rejects.toBe(updateFailure);
    expect(client.profile).toBeNull();
    expect(entity).toMatchObject({
      names: ["Agent", "Account A", "account-a"],
      metadata: { twitter: { id: "account-a" } },
    });
  });
});
