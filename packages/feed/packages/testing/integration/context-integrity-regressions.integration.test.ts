import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@feed/db";
import { generateEvents, loadSharedPostContext } from "@feed/engine";
import { generateSnowflakeId } from "@feed/shared";

describe("Context integrity regressions", () => {
  const createdPostIds: string[] = [];

  afterAll(async () => {
    if (createdPostIds.length > 0) {
      await db.post.deleteMany({
        where: {
          id: { in: createdPostIds },
        },
      });
    }
  });

  test("loadSharedPostContext(asOf) excludes future posts and uses posts.timestamp (not createdAt)", async () => {
    const asOf = new Date();

    // Use timestamps close to asOf so these posts land near the top of the context window.
    const postATimestamp = new Date(asOf.getTime() - 2_000);
    const postBTimestamp = new Date(asOf.getTime() - 3_000);
    const futureTimestamp = new Date(asOf.getTime() + 10 * 60 * 1_000);

    // Intentionally invert createdAt ordering to prove we sort and display by posts.timestamp.
    const postACreatedAt = new Date(asOf.getTime() - 5 * 60 * 1_000);
    const postBCreatedAt = new Date(asOf.getTime() - 1_000);

    const postAId = await generateSnowflakeId();
    const postBId = await generateSnowflakeId();
    const futurePostId = await generateSnowflakeId();

    createdPostIds.push(postAId, postBId, futurePostId);

    const marker = postAId.slice(-8);
    const authorId = `test-context-author-${marker}`;

    const postAContent = `ctx-past-A-${marker}`;
    const postBContent = `ctx-past-B-${marker}`;
    const futureContent = `ctx-future-${marker}`;

    await db.post.create({
      data: {
        id: postAId,
        type: "post",
        content: postAContent,
        authorId,
        timestamp: postATimestamp,
        createdAt: postACreatedAt,
      },
    });

    await db.post.create({
      data: {
        id: postBId,
        type: "post",
        content: postBContent,
        authorId,
        timestamp: postBTimestamp,
        createdAt: postBCreatedAt,
      },
    });

    // Looks like a lookahead post: created now, but timestamp in the future.
    await db.post.create({
      data: {
        id: futurePostId,
        type: "post",
        content: futureContent,
        authorId,
        timestamp: futureTimestamp,
        createdAt: asOf,
      },
    });

    const context = await loadSharedPostContext(asOf);

    // Strong invariant: prompt context must not include any future posts.
    for (const post of context.recentFeedPosts) {
      expect(new Date(post.timestamp).getTime()).toBeLessThanOrEqual(
        asOf.getTime(),
      );
    }

    // Our explicit future post must not appear.
    expect(
      context.recentFeedPosts.some((p) => p.content.includes(futureContent)),
    ).toBe(false);

    // Our past posts should appear, and their timestamps must reflect posts.timestamp (not createdAt).
    const foundA = context.recentFeedPosts.find((p) =>
      p.content.includes(postAContent),
    );
    const foundB = context.recentFeedPosts.find((p) =>
      p.content.includes(postBContent),
    );
    expect(foundA).toBeTruthy();
    expect(foundB).toBeTruthy();

    expect(
      Math.abs(
        new Date(foundA?.timestamp).getTime() - postATimestamp.getTime(),
      ),
    ).toBeLessThan(1_000);
    expect(
      Math.abs(
        new Date(foundB?.timestamp).getTime() - postBTimestamp.getTime(),
      ),
    ).toBeLessThan(1_000);

    // Ordering should be by posts.timestamp desc (A is newer than B).
    const indexA = context.recentFeedPosts.findIndex((p) =>
      p.content.includes(postAContent),
    );
    const indexB = context.recentFeedPosts.findIndex((p) =>
      p.content.includes(postBContent),
    );
    expect(indexA).toBeGreaterThanOrEqual(0);
    expect(indexB).toBeGreaterThanOrEqual(0);
    expect(indexA).toBeLessThan(indexB);
  });

  test("generateEvents persists game-relative dayNumber from currentDay", async () => {
    const timestamp = new Date();
    const questionId = await generateSnowflakeId();
    const suffix = questionId.slice(-8);

    const questionText = `Integration test: event dayNumber ${suffix}`;
    const expectedDayNumber = 7;
    const expectedQuestionNumber = 999_999;

    // generateEvents should store dayNumber directly from currentDay (game-relative),
    // not compute epoch-day internally.
    const created = await generateEvents(
      [
        {
          id: questionId,
          text: questionText,
          questionNumber: expectedQuestionNumber,
        },
      ],
      timestamp,
      expectedDayNumber,
    );

    expect(created).toBe(1);

    const events = await db.worldEvent.findMany({
      where: {
        relatedQuestion: { equals: expectedQuestionNumber },
        gameId: { equals: "continuous" },
        timestamp: { gte: new Date(timestamp.getTime() - 1_000) },
      },
      orderBy: { timestamp: "desc" },
      take: 5,
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.dayNumber).toBe(expectedDayNumber);
    expect(
      events.some((event) => event.description.includes(questionText)),
    ).toBe(true);

    // Cleanup the created event(s) by question number marker to avoid polluting other tests.
    await db.worldEvent.deleteMany({
      where: {
        relatedQuestion: { equals: expectedQuestionNumber },
        gameId: { equals: "continuous" },
      },
    });
  });
});
