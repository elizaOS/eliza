/**
 * APIs should not expose future posts or events.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { cachedDb } from "@feed/api";
import { db, generateSnowflakeId, getDbInstance } from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";

const BASE_URL =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  "http://localhost:3000";

async function assertOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  throw new Error(
    `Expected ${response.url} to succeed, received ${response.status}: ${await response.text()}`,
  );
}

describe("Time Filtering - API Endpoints", () => {
  let testActorId: string;
  let testUserId: string;
  let futurePostId: string;
  let pastPostId: string;
  let currentPostId: string;
  let now: Date;
  let oneHourAgo: Date;
  let oneHourFuture: Date;

  beforeAll(async () => {
    now = new Date();
    oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    oneHourFuture = new Date(now.getTime() + 60 * 60 * 1000);

    const allActors = StaticDataRegistry.getAllActors();
    const firstActor = allActors[0];
    if (!firstActor) {
      throw new Error(
        "No actors in registry - cannot run time filtering tests",
      );
    }
    testActorId = firstActor.id;

    const user = await db.user.create({
      data: {
        id: await generateSnowflakeId(),
        username: `test-user-${Date.now()}`,
        displayName: "Test User",
        isTest: false,
        updatedAt: new Date(),
      },
    });
    testUserId = user.id;

    const pastPost = await db.post.create({
      data: {
        id: await generateSnowflakeId(),
        content: "Past post",
        authorId: testActorId,
        gameId: "continuous",
        dayNumber: Math.floor(Date.now() / (1000 * 60 * 60 * 24)),
        timestamp: oneHourAgo,
        type: "post",
      },
    });
    pastPostId = pastPost.id;

    const currentPost = await db.post.create({
      data: {
        id: await generateSnowflakeId(),
        content: "Current post",
        authorId: testActorId,
        gameId: "continuous",
        dayNumber: Math.floor(Date.now() / (1000 * 60 * 60 * 24)),
        timestamp: now,
        type: "post",
      },
    });
    currentPostId = currentPost.id;

    const futurePost = await db.post.create({
      data: {
        id: await generateSnowflakeId(),
        content: "Future post - should not appear",
        authorId: testActorId,
        gameId: "continuous",
        dayNumber: Math.floor(Date.now() / (1000 * 60 * 60 * 24)),
        timestamp: oneHourFuture,
        type: "post",
      },
    });
    futurePostId = futurePost.id;
  });

  afterAll(async () => {
    await db.post.deleteMany({
      where: {
        id: { in: [pastPostId, currentPostId, futurePostId] },
      },
    });
    if (testUserId) {
      await db.user.delete({ where: { id: testUserId } });
    }
  });

  describe("Database Service Methods", () => {
    it("getRecentPosts should filter out future posts", async () => {
      const [pastPost, currentPost, futurePost] = await Promise.all([
        db.post.findUnique({ where: { id: pastPostId } }),
        db.post.findUnique({ where: { id: currentPostId } }),
        db.post.findUnique({ where: { id: futurePostId } }),
      ]);

      expect(pastPost).toBeTruthy();
      expect(currentPost).toBeTruthy();
      expect(futurePost).toBeTruthy();

      const freshNow = new Date();
      expect(pastPost?.timestamp.getTime()).toBeLessThan(freshNow.getTime());
      expect(currentPost?.timestamp.getTime()).toBeLessThanOrEqual(
        freshNow.getTime(),
      );
      expect(futurePost?.timestamp.getTime()).toBeGreaterThan(
        freshNow.getTime(),
      );

      const posts = await getDbInstance().getRecentPosts(100);
      const postIds = posts.map((p) => p.id);

      expect(postIds).not.toContain(futurePostId);

      for (const post of posts) {
        expect(post.timestamp.getTime()).toBeLessThanOrEqual(
          freshNow.getTime(),
        );
      }
    });

    it("getPostsByActor should filter out future posts", async () => {
      const actor = StaticDataRegistry.getActor(testActorId);
      expect(actor).toBeTruthy();

      const posts = await getDbInstance().getPostsByActor(testActorId, 100);
      const postIds = posts.map((p) => p.id);

      expect(postIds).not.toContain(futurePostId);

      const freshNow = new Date();
      for (const post of posts) {
        expect(post.timestamp.getTime()).toBeLessThanOrEqual(
          freshNow.getTime(),
        );
      }

      if (posts.length > 0) {
        expect(postIds).toContain(pastPostId);
        expect(postIds).toContain(currentPostId);
      }
    });
  });

  describe("Cached Database Service Methods", () => {
    it("getRecentPosts should filter out future posts", async () => {
      const posts = await cachedDb.getRecentPosts(100);
      const postIds = posts.map((p) => p.id);

      expect(postIds).not.toContain(futurePostId);

      const freshNow = new Date();
      for (const post of posts) {
        expect(post.timestamp.getTime()).toBeLessThanOrEqual(
          freshNow.getTime(),
        );
      }
    });

    it("getPostsByActor should filter out future posts", async () => {
      const posts = await cachedDb.getPostsByActor(testActorId, 100);
      const postIds = posts.map((p) => p.id);

      expect(postIds).not.toContain(futurePostId);

      const freshNow = new Date();
      for (const post of posts) {
        expect(post.timestamp.getTime()).toBeLessThanOrEqual(
          freshNow.getTime(),
        );
      }
    });

    it("getPostsForFollowing should filter out future posts", async () => {
      await db.follow.create({
        data: {
          id: await generateSnowflakeId(),
          followerId: testUserId,
          followingId: testActorId,
        },
      });

      const posts = await cachedDb.getPostsForFollowing(
        testUserId,
        [testActorId],
        100,
      );
      const postIds = posts.map((p) => p.id);

      expect(postIds).not.toContain(futurePostId);

      const freshNow = new Date();
      for (const post of posts) {
        expect(post.timestamp.getTime()).toBeLessThanOrEqual(
          freshNow.getTime(),
        );
      }

      await db.follow.deleteMany({
        where: { followerId: testUserId, followingId: testActorId },
      });
    });
  });

  describe("API Route Integration", () => {
    it("GET /api/posts should filter out future posts", async () => {
      const response = await fetch(`${BASE_URL}/api/posts?limit=100`);
      await assertOk(response);
      const data = await response.json();

      expect(data.success).toBe(true);
      const postIds = data.posts.map((p: { id: string }) => p.id);

      expect(postIds).not.toContain(futurePostId);

      const freshNow = new Date();
      for (const post of data.posts as Array<{
        id: string;
        timestamp: string;
      }>) {
        const postTime = new Date(post.timestamp).getTime();
        expect(postTime).toBeLessThanOrEqual(freshNow.getTime());
      }
    });

    it("GET /api/posts?actorId=... should filter out future posts", async () => {
      const response = await fetch(
        `${BASE_URL}/api/posts?actorId=${testActorId}&limit=100`,
      );
      await assertOk(response);
      const data = await response.json();

      expect(data.success).toBe(true);
      const postIds = data.posts.map((p: { id: string }) => p.id);

      expect(postIds).not.toContain(futurePostId);

      const freshNow = new Date();
      for (const post of data.posts as Array<{
        id: string;
        timestamp: string;
      }>) {
        const postTime = new Date(post.timestamp).getTime();
        expect(postTime).toBeLessThanOrEqual(freshNow.getTime());
      }
    });

    it("GET /api/users/[userId]/posts should filter out future posts", async () => {
      const userPastPost = await db.post.create({
        data: {
          id: await generateSnowflakeId(),
          content: "User past post",
          authorId: testUserId,
          gameId: "continuous",
          dayNumber: Math.floor(Date.now() / (1000 * 60 * 60 * 24)),
          timestamp: oneHourAgo,
          type: "post",
        },
      });

      const userFuturePost = await db.post.create({
        data: {
          id: await generateSnowflakeId(),
          content: "User future post",
          authorId: testUserId,
          gameId: "continuous",
          dayNumber: Math.floor(Date.now() / (1000 * 60 * 60 * 24)),
          timestamp: oneHourFuture,
          type: "post",
        },
      });

      const response = await fetch(`${BASE_URL}/api/users/${testUserId}/posts`);
      await assertOk(response);
      const data = await response.json();

      expect(Array.isArray(data.items)).toBe(true);
      expect(typeof data.total).toBe("number");
      expect(data.type).toBe("posts");
      const postIds = data.items.map((p: { id: string }) => p.id);

      expect(postIds).not.toContain(userFuturePost.id);

      const freshNow = new Date();
      for (const item of data.items as Array<{
        id: string;
        timestamp: string;
      }>) {
        const postTime = new Date(item.timestamp).getTime();
        expect(postTime).toBeLessThanOrEqual(freshNow.getTime());
      }

      await db.post.deleteMany({
        where: { id: { in: [userPastPost.id, userFuturePost.id] } },
      });
    });

    it("GET /api/feed/widgets/breaking-news should filter out future events", async () => {
      const pastEvent = await db.worldEvent.create({
        data: {
          id: await generateSnowflakeId(),
          eventType: "announcement",
          description: "Past breaking news event",
          timestamp: oneHourAgo,
          visibility: "public",
          gameId: "continuous",
        },
      });

      const futureEvent = await db.worldEvent.create({
        data: {
          id: await generateSnowflakeId(),
          eventType: "announcement",
          description: "Future breaking news event",
          timestamp: oneHourFuture,
          visibility: "public",
          gameId: "continuous",
        },
      });

      const response = await fetch(
        `${BASE_URL}/api/feed/widgets/breaking-news`,
      );
      await assertOk(response);
      const data = await response.json();

      expect(data.success).toBe(true);
      const eventIds = data.news.map((n: { id: string }) => n.id);

      expect(eventIds).not.toContain(futureEvent.id);

      const freshNow = new Date();
      for (const item of data.news as Array<{
        id: string;
        timestamp: string;
      }>) {
        const eventTime = new Date(item.timestamp).getTime();
        expect(eventTime).toBeLessThanOrEqual(freshNow.getTime());
      }

      await db.worldEvent.deleteMany({
        where: { id: { in: [pastEvent.id, futureEvent.id] } },
      });
    });

    it("GET /api/feed/widgets/trending-posts should filter out future posts", async () => {
      const response = await fetch(
        `${BASE_URL}/api/feed/widgets/trending-posts`,
      );
      await assertOk(response);
      const data = await response.json();

      expect(Array.isArray(data.posts)).toBe(true);
      const postIds = data.posts.map((p: { id: string }) => p.id);

      expect(postIds).not.toContain(futurePostId);

      const freshNow = new Date();
      for (const post of data.posts as Array<{
        id: string;
        timestamp: string;
      }>) {
        const postTime = new Date(post.timestamp).getTime();
        expect(postTime).toBeLessThanOrEqual(freshNow.getTime());
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle posts exactly at current time", async () => {
      const freshNow = new Date();
      const posts = await getDbInstance().getRecentPosts(100);
      const currentPost = posts.find((p) => p.id === currentPostId);
      if (currentPost) {
        expect(currentPost.timestamp.getTime()).toBeLessThanOrEqual(
          freshNow.getTime(),
        );
      }

      expect(posts.length).toBeGreaterThan(0);
    });

    it("should handle posts a few seconds in the future", async () => {
      const freshNow = new Date();
      const nearFuture = new Date(freshNow.getTime() + 5000);
      const edgeCasePost = await db.post.create({
        data: {
          id: await generateSnowflakeId(),
          content: "Edge case - near future",
          authorId: testActorId,
          gameId: "continuous",
          dayNumber: Math.floor(Date.now() / (1000 * 60 * 60 * 24)),
          timestamp: nearFuture,
          type: "post",
        },
      });

      const posts = await getDbInstance().getRecentPosts(100);
      const postIds = posts.map((p) => p.id);

      expect(postIds).not.toContain(edgeCasePost.id);

      await db.post.delete({ where: { id: edgeCasePost.id } });
    });

    it("should handle posts far in the future", async () => {
      const freshNow = new Date();
      const farFuture = new Date(freshNow.getTime() + 24 * 60 * 60 * 1000);
      const farFuturePost = await db.post.create({
        data: {
          id: await generateSnowflakeId(),
          content: "Far future post",
          authorId: testActorId,
          gameId: "continuous",
          dayNumber: Math.floor(Date.now() / (1000 * 60 * 60 * 24)),
          timestamp: farFuture,
          type: "post",
        },
      });

      const posts = await getDbInstance().getRecentPosts(100);
      const postIds = posts.map((p) => p.id);

      expect(postIds).not.toContain(farFuturePost.id);

      await db.post.delete({ where: { id: farFuturePost.id } });
    });
  });
});
