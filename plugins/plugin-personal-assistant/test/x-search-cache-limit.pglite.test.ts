/**
 * X post search falls back to the real PGlite LifeOps feed cache when the X
 * search call is not available (no X service, or X refuses the search). The
 * caller's limit caps the matches. It must not cap the cached rows that are
 * read before the query filter, or newer posts that do not match hide every
 * older match and the search fails although the cache holds matches. X verify
 * (`CONNECTOR` with `query` and `recentLimit`) reads through this path. The X
 * connector is intentionally absent so the search takes the cached path.
 */
import type {
  LifeOpsConnectorGrant,
  LifeOpsXFeedItem,
  LifeOpsXFeedType,
} from "@elizaos/contracts";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LifeOpsService } from "../src/lifeops/service.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

let runtimeResult: RealTestRuntimeResult | null = null;
let runtime: AgentRuntime;
let service: LifeOpsService;

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function seedPost(args: {
  feedType: LifeOpsXFeedType;
  tweetId: string;
  minutesAgo: number;
  text: string;
}): LifeOpsXFeedItem {
  const now = new Date().toISOString();
  return {
    id: `${runtime.agentId}:x-feed:${args.feedType}:${args.tweetId}`,
    agentId: runtime.agentId,
    externalTweetId: args.tweetId,
    authorHandle: "friend",
    authorId: "1001",
    text: args.text,
    createdAtSource: minutesAgoIso(args.minutesAgo),
    feedType: args.feedType,
    metadata: { source: "plugin-x-runtime" },
    syncedAt: now,
    updatedAt: now,
  };
}

/**
 * Newest-to-oldest in each feed: three posts that do not match the query
 * above one older post that matches it.
 */
function seedCache(): LifeOpsXFeedItem[] {
  return [
    seedPost({
      feedType: "home_timeline",
      tweetId: "home-1",
      minutesAgo: 1,
      text: "coffee time",
    }),
    seedPost({
      feedType: "home_timeline",
      tweetId: "home-2",
      minutesAgo: 2,
      text: "weekend plans",
    }),
    seedPost({
      feedType: "home_timeline",
      tweetId: "home-3",
      minutesAgo: 3,
      text: "new album out",
    }),
    seedPost({
      feedType: "home_timeline",
      tweetId: "home-old",
      minutesAgo: 30,
      text: "Shipping the Eliza launch today",
    }),
    seedPost({
      feedType: "mentions",
      tweetId: "mention-1",
      minutesAgo: 4,
      text: "@owner hi",
    }),
    seedPost({
      feedType: "mentions",
      tweetId: "mention-2",
      minutesAgo: 5,
      text: "@owner thanks",
    }),
    seedPost({
      feedType: "mentions",
      tweetId: "mention-3",
      minutesAgo: 6,
      text: "@owner ok",
    }),
    seedPost({
      feedType: "mentions",
      tweetId: "mention-old",
      minutesAgo: 40,
      text: "@owner the Eliza launch looks great",
    }),
  ];
}

beforeAll(async () => {
  runtimeResult = await createLifeOpsTestRuntime();
  runtime = runtimeResult.runtime;
  service = new LifeOpsService(runtime);

  const now = new Date().toISOString();
  const grant: LifeOpsConnectorGrant = {
    id: "connector-account:x-search-cache-owner",
    agentId: runtime.agentId,
    provider: "x",
    connectorAccountId: "x-search-cache-owner",
    side: "owner",
    identity: { id: "67890", username: "search_cache_owner" },
    identityEmail: null,
    grantedScopes: [],
    capabilities: ["x.read"],
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent: true,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await service.repository.upsertConnectorGrant(grant);
  for (const post of seedCache()) {
    await service.repository.upsertXFeedItem(post);
  }
});

afterAll(async () => {
  await runtimeResult?.cleanup();
});

describe("X post search over the real PGlite feed cache", () => {
  it("finds cached matches that are older than the newest `limit` posts", async () => {
    const posts = await service.searchXPosts("eliza launch", { limit: 3 });

    expect(posts.map((post) => post.externalTweetId)).toEqual([
      "home-old",
      "mention-old",
    ]);
  });

  it("returns no more matches than the limit", async () => {
    const posts = await service.searchXPosts("eliza launch", { limit: 1 });

    expect(posts.map((post) => post.externalTweetId)).toEqual(["home-old"]);
  });
});
