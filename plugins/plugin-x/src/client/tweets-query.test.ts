/**
 * Timeline pagination guard and the tweet-query helpers.
 *
 * `nextTimelinePageCursor` is what stops a repeating provider cursor from
 * looping forever, and `getTweetWhere` / `getTweetsWhere` are the public
 * filtering surface exposed on the client. None of them had tests.
 *
 * No network: every case drives an in-memory async iterable.
 */

import { describe, expect, it } from "vitest";
import {
  getTweetsWhere,
  getTweetWhere,
  nextTimelinePageCursor,
  type Tweet,
} from "./tweets";

function tweet(overrides: Partial<Tweet>): Tweet {
  return { id: "0", text: "", isRetweet: false, ...overrides } as Tweet;
}

async function* streamOf(tweets: Tweet[]): AsyncGenerator<Tweet> {
  for (const entry of tweets) yield entry;
}

const sample = [
  tweet({ id: "1", text: "keep", isRetweet: false }),
  tweet({ id: "2", text: "drop", isRetweet: true }),
  tweet({ id: "3", text: "keep", isRetweet: false }),
];

const ids = (tweets: Tweet[]) => tweets.map((entry) => entry.id);

describe("nextTimelinePageCursor", () => {
  it("ends the run on a terminal page", () => {
    const seen = new Set<string>();
    expect(
      nextTimelinePageCursor("mentions", undefined, seen, 3),
    ).toBeUndefined();
    expect(seen.size).toBe(0);
  });

  it("ends the run on an empty-string cursor", () => {
    // `""` is falsy, so it must be treated as terminal rather than recorded
    // and then re-reported as a repeat on the following page.
    const seen = new Set<string>();
    expect(nextTimelinePageCursor("mentions", "", seen, 1)).toBeUndefined();
    expect(seen.size).toBe(0);
  });

  it("records and returns a fresh cursor", () => {
    const seen = new Set<string>();
    expect(nextTimelinePageCursor("mentions", "cursor-a", seen, 1)).toBe(
      "cursor-a",
    );
    expect(seen.has("cursor-a")).toBe(true);
  });

  it("refuses an immediately repeated cursor", () => {
    const seen = new Set<string>(["cursor-a"]);
    expect(() =>
      nextTimelinePageCursor("mentions", "cursor-a", seen, 2),
    ).toThrow(/repeated a page cursor/);
  });

  it("refuses a LONGER cycle, not just an immediate repeat", () => {
    // A -> B -> A is the case a "same as last cursor" check would miss, and it
    // loops just as permanently.
    const seen = new Set<string>();
    nextTimelinePageCursor("mentions", "A", seen, 1);
    nextTimelinePageCursor("mentions", "B", seen, 2);
    expect(() => nextTimelinePageCursor("mentions", "A", seen, 3)).toThrow(
      /repeated a page cursor/,
    );
  });

  it("carries the source and page count for diagnosis", () => {
    const seen = new Set<string>(["cursor-a"]);
    try {
      nextTimelinePageCursor("home-timeline", "cursor-a", seen, 7);
      expect.unreachable("expected a pagination refusal");
    } catch (error) {
      const typed = error as Error & {
        code?: string;
        context?: Record<string, unknown>;
      };
      expect(typed.code).toBe("X_TIMELINE_PAGINATION_CURSOR_REPEATED");
      expect(typed.message).toContain("home-timeline");
      expect(typed.context).toMatchObject({
        source: "home-timeline",
        pageCount: 7,
      });
    }
  });

  it("does not record a cursor it refused", () => {
    // Otherwise the guard's own bookkeeping would grow on every failure.
    const seen = new Set<string>(["cursor-a"]);
    expect(() =>
      nextTimelinePageCursor("mentions", "cursor-a", seen, 2),
    ).toThrow();
    expect(seen.size).toBe(1);
  });

  it("keeps separate runs independent through their own Set", () => {
    const first = new Set<string>();
    const second = new Set<string>();
    expect(nextTimelinePageCursor("a", "shared", first, 1)).toBe("shared");
    expect(nextTimelinePageCursor("b", "shared", second, 1)).toBe("shared");
  });
});

describe("getTweetWhere", () => {
  it("returns the first match for a partial-object query", async () => {
    const found = await getTweetWhere(streamOf(sample), { text: "keep" });
    expect(found?.id).toBe("1");
  });

  it("returns null when nothing matches", async () => {
    const found = await getTweetWhere(streamOf(sample), { text: "absent" });
    expect(found).toBeNull();
  });

  it("matches every key of a multi-key query, not just one", async () => {
    expect(
      (await getTweetWhere(streamOf(sample), { text: "keep", isRetweet: true }))
        ?.id,
    ).toBeUndefined();
    expect(
      (await getTweetWhere(streamOf(sample), { text: "drop", isRetweet: true }))
        ?.id,
    ).toBe("2");
  });

  it("accepts a synchronous predicate", async () => {
    const found = await getTweetWhere(
      streamOf(sample),
      (entry) => entry.id === "3",
    );
    expect(found?.id).toBe("3");
  });

  it("awaits an ASYNC predicate", async () => {
    const found = await getTweetWhere(
      streamOf(sample),
      async (entry) => entry.text === "keep" && entry.id === "3",
    );
    expect(found?.id).toBe("3");
  });

  it("stops consuming the stream once it has a match", async () => {
    let produced = 0;
    async function* counted() {
      for (const entry of sample) {
        produced += 1;
        yield entry;
      }
    }
    await getTweetWhere(counted(), { id: "1" });
    expect(produced).toBe(1);
  });
});

describe("getTweetsWhere", () => {
  it("collects every match for a partial-object query", async () => {
    expect(
      ids(await getTweetsWhere(streamOf(sample), { text: "keep" })),
    ).toEqual(["1", "3"]);
  });

  it("returns an empty array rather than null when nothing matches", async () => {
    expect(await getTweetsWhere(streamOf(sample), { text: "absent" })).toEqual(
      [],
    );
  });

  it("accepts a synchronous predicate", async () => {
    expect(
      ids(
        await getTweetsWhere(
          streamOf(sample),
          (entry) => entry.isRetweet === true,
        ),
      ),
    ).toEqual(["2"]);
  });

  it("awaits an ASYNC predicate instead of keeping everything", async () => {
    // `TweetQuery` permits `Promise<boolean>`. An unawaited Promise is always
    // truthy, so the filter would return all three tweets — a filter that
    // filters nothing, and silently.
    expect(
      ids(
        await getTweetsWhere(
          streamOf(sample),
          async (entry) => entry.text === "keep",
        ),
      ),
    ).toEqual(["1", "3"]);
  });

  it("honours an async predicate that rejects everything", async () => {
    expect(await getTweetsWhere(streamOf(sample), async () => false)).toEqual(
      [],
    );
  });

  it("preserves stream order", async () => {
    expect(ids(await getTweetsWhere(streamOf(sample), () => true))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("propagates a rejected predicate rather than dropping the tweet", async () => {
    await expect(
      getTweetsWhere(streamOf(sample), async () => {
        throw new Error("predicate failed");
      }),
    ).rejects.toThrow(/predicate failed/);
  });

  it("compares strictly, so a loosely-equal value does NOT match", async () => {
    // `"0" == 0` is true. A `==` comparison would let a numeric id from a
    // caller match a string id from the API, silently widening the filter.
    const numericQuery = { id: 0 } as unknown as Partial<Tweet>;
    expect(
      await getTweetsWhere(streamOf([tweet({ id: "0" })]), numericQuery),
    ).toEqual([]);
    const emptyStringQuery = { text: "" } as Partial<Tweet>;
    expect(
      ids(
        await getTweetsWhere(
          streamOf([tweet({ id: "9", text: "" })]),
          emptyStringQuery,
        ),
      ),
    ).toEqual(["9"]);
  });

  it("treats an empty query object as matching everything", async () => {
    // `Object.keys({}).every(...)` is vacuously true. Pinned so the behaviour
    // is a decision rather than an accident of the implementation.
    expect(ids(await getTweetsWhere(streamOf(sample), {}))).toEqual([
      "1",
      "2",
      "3",
    ]);
  });
});
