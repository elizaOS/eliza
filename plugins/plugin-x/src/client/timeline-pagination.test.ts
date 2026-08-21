/**
 * Regression tests for the user-timeline pagination generators
 * (`getTweets`, `getTweetsByUserId`, `getTweetsAndReplies`,
 * `getTweetsAndRepliesByUserId` in `tweets.ts` and
 * `Client.getUserTweetsIterator` in `client.ts`).
 *
 * These pin two things: repeated provider cursors fail instead of looping, and
 * ordinary multi-page timelines follow provider continuation tokens through
 * to completion without an arbitrary page ceiling.
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

let screenNameSeq = 0;
/** Unique screen name per case so the profile id cache cannot mask a lookup. */
function freshScreenName() {
  screenNameSeq += 1;
  return `alice-${screenNameSeq}`;
}

describe("user-timeline pagination rejects cursor cycles", () => {
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

  it("a timeline beyond the former thousand-page ceiling still completes", async () => {
    const formerPageLimit = 1_000;
    const { auth, state } = stubAuth((index) =>
      index < formerPageLimit
        ? { ids: [], next: `cursor-${index}` }
        : { ids: ["after-former-limit"] },
    );

    const ids = await collect(getTweetsByUserId("user-1", 1, auth as never));

    expect(ids).toEqual(["after-former-limit"]);
    expect(state.calls).toBe(formerPageLimit + 1);
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
