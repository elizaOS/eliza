/**
 * Discovery follows the discovered account by its X user id. Real
 * TwitterDiscoveryClient.processAccounts, Client.followUser and
 * relationships.followUser; only the twitter-api-v2 client is a stand-in. It
 * applies X's username rule ^[A-Za-z0-9_]{1,15}$ (400 otherwise) and has an
 * unrelated account whose @username is "783214".
 */
import { type IAgentRuntime, logger, type UUID } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import type { ClientBase } from "./base";
import { Client } from "./client";
import { TwitterDiscoveryClient } from "./discovery";
import type { TwitterClientState } from "./types";

function makeClient(users: Record<string, string>, follows: string[]) {
  const v2 = {
    v2: {
      userByUsername: async (username: string) => {
        if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) {
          throw Object.assign(new Error("Request failed with code 400"), {
            code: 400,
          });
        }
        const id = users[username.toLowerCase()];
        return id
          ? { data: { id, username } }
          : { errors: [{ title: "Not Found Error" }] };
      },
      me: async () => ({ data: { id: "999" } }),
      follow: async (_me: string, target: string) => {
        follows.push(target);
        return { data: { following: true } };
      },
    },
  };
  const auth = {
    getV2Client: async () => v2,
    withAuthenticatedSession: async (
      op: (session: { client: typeof v2; revision: number }) => unknown,
    ) => op({ client: v2, revision: 1 }),
    getAuthenticatedSession: async () => ({ client: v2, revision: 1 }),
    isAuthenticatedSessionCurrent: () => true,
  };
  const client = new Client();
  (client as unknown as { auth: typeof auth }).auth = auth;
  return client;
}

async function run(accountId: string, username: string) {
  for (const k of ["log", "info", "warn", "error", "debug"] as const)
    (logger as unknown as Record<string, unknown>)[k] = vi.fn();
  const follows: string[] = [];
  // @alice_rust is id <accountId>; an unrelated account is literally @783214.
  const twitterClient = makeClient(
    { alice_rust: accountId, "783214": "5550001" },
    follows,
  );
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000ac" as UUID,
    character: { name: "Agent", templates: {}, topics: ["rust"] },
    getSetting: vi.fn(() => undefined),
    reportError: vi.fn(),
    ensureRoomExists: vi.fn(async () => undefined),
    ensureWorldExists: vi.fn(async () => undefined),
    ensureConnection: vi.fn(async () => undefined),
    createMemory: vi.fn(async () => undefined),
    getMemoryById: vi.fn(async () => null),
    useModel: vi.fn(async () => [0.1, 0.2]),
    searchMemories: vi.fn(async () => []),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  const base = {
    accountId: "default",
    runtime,
    twitterClient,
    isAuthenticatedSessionCurrent: () => true,
  } as unknown as ClientBase;
  const discovery = new TwitterDiscoveryClient(
    base,
    runtime,
    {} as TwitterClientState,
  );
  const internals = discovery as unknown as {
    delay: () => Promise<void>;
    processAccounts: (
      accounts: unknown[],
      session: { revision: number },
    ) => Promise<number>;
  };
  internals.delay = async () => undefined;
  let error: unknown;
  try {
    await internals.processAccounts(
      [
        {
          user: {
            id: accountId,
            username,
            name: "Alice",
            followersCount: 5000,
          },
          qualityScore: 0.9,
          relevanceScore: 0.9,
        },
      ],
      { revision: 1 },
    );
  } catch (e) {
    error = e;
  }
  return { follows, error };
}

it("follows a discovered account by its 19-digit id", async () => {
  const r = await run("1712345678901234567", "alice_rust");
  expect(r.error).toBeUndefined();
  expect(r.follows).toEqual(["1712345678901234567"]);
});

it("follows the discovered account, not the one whose @username equals a short id", async () => {
  const r = await run("783214", "alice_rust");
  expect(r.error).toBeUndefined();
  expect(r.follows).toEqual(["783214"]);
});
