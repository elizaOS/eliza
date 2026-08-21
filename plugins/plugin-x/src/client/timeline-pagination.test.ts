/**
 * Regression tests for the user-timeline pagination generators
 * (`getTweets`, `getTweetsByUserId`, `getTweetsAndReplies`,
 * `getTweetsAndRepliesByUserId` in `tweets.ts` and
 * `Client.getUserTweetsIterator` in `client.ts`).
 *
 * These pin two things: that a provider which never stops paginating —
 * including the real X API v2 case of a page with zero tweets and a live
 * `next_token` — terminates with a typed error instead of looping forever, and
 * that ordinary multi-page timelines still page through to completion.
 *
 * The provider is a local re-implementation of the `twitter-api-v2` paginator
 * surface these helpers touch: async iteration over the page's tweets,
 * `.includes`, and `.meta.next_token`. Each request costs one macrotask, the
 * way a real network hop does.
 *
 * Termination is asserted as a race against a watchdog rather than a bare
 * `await`, because an unbounded generator never settles: a regression must
 * surface as `expect("STILL-RUNNING").toBe(<code>)` in a few seconds instead of
 * hanging the runner until its own timeout.
 */
import { describe, expect, it } from "vitest";
import { Client } from "./client";
import {
  getTweets,
  getTweetsAndReplies,
  getTweetsAndRepliesByUserId,
  getTweetsByUserId,
  MAX_TIMELINE_PAGES,
} from "./tweets";

const WATCHDOG_MS = 5_000;
/** Backstop so a reverted generator cannot spin for the rest of the file. */
const HARNESS_CALL_CEILING = 200_000;

type Page = { ids: string[]; next?: string };
type ProviderState = { calls: number; stop: boolean };

function timelinePage(page: Page) {
  return {
    includes: undefined,
    meta: page.next ? { next_token: page.next } : {},
    async *[Symbol.asyncIterator]() {
      for (const id of page.ids) {
        yield { id, text: `tweet ${id}` };
      }
    },
  };
}

/** Builds a stub `TwitterAuth` serving `pages(index)` and counting requests. */
function stubAuth(pages: (index: number) => Page) {
  const state: ProviderState = { calls: 0, stop: false };
  const auth = {
    async getV2Client() {
      return {
        v2: {
          async userByUsername(username: string) {
            return { data: { id: `id-${username}`, username, name: username } };
          },
          async userTimeline() {
            await new Promise((resolve) => setImmediate(resolve));
            if (state.stop || state.calls >= HARNESS_CALL_CEILING) {
              throw new Error("HARNESS-STOP");
            }
            const page = pages(state.calls);
            state.calls += 1;
            return timelinePage(page);
          },
        },
      };
    },
    async withAuthenticatedSession(
      operation: (session: unknown) => Promise<unknown>,
    ) {
      return operation({ client: "client-1", revision: 1 });
    },
    async getAuthenticatedSession() {
      return { client: "client-1", revision: 1 };
    },
    isAuthenticatedSessionCurrent() {
      return true;
    },
  };
  return { auth, state };
}

function clientWith(auth: unknown): Client {
  const client = new Client();
  (client as unknown as { auth: unknown }).auth = auth;
  return client;
}

async function collect(iterable: AsyncIterable<{ id: string }>) {
  const ids: string[] = [];
  for await (const tweet of iterable) {
    ids.push(tweet.id);
  }
  return ids;
}

/** Resolves to the thrown `ElizaError` code, `"COMPLETED"`, or the watchdog's
 * `"STILL-RUNNING"` sentinel when the generator never settles. */
async function terminationOf(
  iterable: AsyncIterable<{ id: string }>,
  state: ProviderState,
) {
  const consume = collect(iterable).then(
    () => "COMPLETED",
    (error: { code?: string; message: string }) => error.code ?? error.message,
  );
  const watchdog = new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("STILL-RUNNING"), WATCHDOG_MS);
    timer.unref?.();
  });
  const outcome = await Promise.race([consume, watchdog]);
  state.stop = true;
  await consume;
  return outcome;
}

/** Every page is empty but always advertises a brand new cursor — the real X
 * API v2 shape when server-side filtering empties a non-final page. */
const emptyPageWithNovelCursor = (index: number): Page => ({
  ids: [],
  next: `cursor-${index}`,
});

let screenNameSeq = 0;
/** Unique screen name per case so the profile id cache cannot mask a lookup. */
function freshScreenName() {
  screenNameSeq += 1;
  return `alice-${screenNameSeq}`;
}

describe("user-timeline pagination is bounded", () => {
  it("getTweets stops on empty pages that keep advertising a new cursor", async () => {
    const { auth, state } = stubAuth(emptyPageWithNovelCursor);

    expect(
      await terminationOf(
        getTweets(freshScreenName(), 200, auth as never),
        state,
      ),
    ).toBe("X_TIMELINE_PAGINATION_LIMIT_EXCEEDED");
    expect(state.calls).toBe(MAX_TIMELINE_PAGES);
  }, 30_000);

  it("getTweetsByUserId stops when the provider repeats a cursor", async () => {
    const { auth, state } = stubAuth(() => ({ ids: [], next: "stuck" }));

    expect(
      await terminationOf(
        getTweetsByUserId("user-1", 200, auth as never),
        state,
      ),
    ).toBe("X_TIMELINE_PAGINATION_CURSOR_REPEATED");
    // Caught on the page that repeats it, not after a third request.
    expect(state.calls).toBe(2);
  }, 30_000);

  it("getTweetsAndReplies catches a longer A -> B -> A cycle", async () => {
    const cycle = ["A", "B", "A"];
    const { auth, state } = stubAuth((index) => ({
      ids: [],
      next: cycle[index] ?? "A",
    }));

    expect(
      await terminationOf(
        getTweetsAndReplies(freshScreenName(), 200, auth as never),
        state,
      ),
    ).toBe("X_TIMELINE_PAGINATION_CURSOR_REPEATED");
    expect(state.calls).toBe(3);
  }, 30_000);

  it("getTweetsAndRepliesByUserId stops on perpetually novel cursors", async () => {
    const { auth, state } = stubAuth(emptyPageWithNovelCursor);

    expect(
      await terminationOf(
        getTweetsAndRepliesByUserId("user-1", 200, auth as never),
        state,
      ),
    ).toBe("X_TIMELINE_PAGINATION_LIMIT_EXCEEDED");
    expect(state.calls).toBe(MAX_TIMELINE_PAGES);
  }, 30_000);

  it("Client.getUserTweetsIterator stops on perpetually novel cursors", async () => {
    const { auth, state } = stubAuth(emptyPageWithNovelCursor);

    expect(
      await terminationOf(
        clientWith(auth).getUserTweetsIterator("user-1", 200),
        state,
      ),
    ).toBe("X_TIMELINE_PAGINATION_LIMIT_EXCEEDED");
    expect(state.calls).toBe(MAX_TIMELINE_PAGES);
  }, 30_000);
});

describe("ordinary timelines still page through completely", () => {
  const threePages = (index: number): Page =>
    index === 0
      ? { ids: ["t1", "t2"], next: "c1" }
      : index === 1
        ? { ids: ["t3", "t4"], next: "c2" }
        : { ids: ["t5"] };

  it("getTweets follows every page until the provider stops", async () => {
    const { auth, state } = stubAuth(threePages);

    expect(
      await collect(getTweets(freshScreenName(), 200, auth as never)),
    ).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(state.calls).toBe(3);
  });

  it("getTweetsByUserId follows every page until the provider stops", async () => {
    const { auth, state } = stubAuth(threePages);

    expect(
      await collect(getTweetsByUserId("user-1", 200, auth as never)),
    ).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(state.calls).toBe(3);
  });

  it("getTweetsAndReplies follows every page until the provider stops", async () => {
    const { auth, state } = stubAuth(threePages);

    expect(
      await collect(getTweetsAndReplies(freshScreenName(), 200, auth as never)),
    ).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(state.calls).toBe(3);
  });

  it("getTweetsAndRepliesByUserId follows every page until the provider stops", async () => {
    const { auth, state } = stubAuth(threePages);

    expect(
      await collect(getTweetsAndRepliesByUserId("user-1", 200, auth as never)),
    ).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(state.calls).toBe(3);
  });

  it("Client.getUserTweetsIterator follows every page until the provider stops", async () => {
    const { auth, state } = stubAuth(threePages);

    expect(
      await collect(clientWith(auth).getUserTweetsIterator("user-1", 200)),
    ).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(state.calls).toBe(3);
  });

  it("a timeline that legitimately ends on the last allowed page still completes", async () => {
    const { auth, state } = stubAuth((index) =>
      index < MAX_TIMELINE_PAGES - 1
        ? { ids: [`t${index}`], next: `cursor-${index}` }
        : { ids: [`t${index}`] },
    );

    const ids = await collect(
      getTweetsByUserId("user-1", MAX_TIMELINE_PAGES, auth as never),
    );

    expect(ids).toHaveLength(MAX_TIMELINE_PAGES);
    expect(state.calls).toBe(MAX_TIMELINE_PAGES);
  }, 30_000);

  it("a satisfied request returns normally even if its last page repeats a cursor", async () => {
    // maxTweets is reached on page 2, whose next_token repeats page 1's. The
    // guards only apply where pagination would actually continue, so this is
    // the same success the pre-fix code produced.
    const { auth, state } = stubAuth((index) =>
      index === 0
        ? { ids: ["t1"], next: "same" }
        : { ids: ["t2"], next: "same" },
    );

    expect(
      await collect(getTweetsByUserId("user-1", 2, auth as never)),
    ).toEqual(["t1", "t2"]);
    expect(state.calls).toBe(2);
  });
});
