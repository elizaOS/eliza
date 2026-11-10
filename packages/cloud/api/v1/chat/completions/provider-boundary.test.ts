/** The rate verdict and the lease commit overlap; every refusal precedes the provider. */
import { describe, expect, test } from "bun:test";
import {
  ClientClosedBeforeDispatchError,
  joinProviderBoundary,
  OrgRateLimitedBeforeDispatchError,
} from "./provider-boundary";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("provider boundary", () => {
  test("the lease commit starts while the rate verdict is still pending", async () => {
    const rate = deferred<Response | null>();
    const commit = deferred<void>();
    const order: string[] = [];
    const boundary = joinProviderBoundary({
      signal: new AbortController().signal,
      rateVerdict: () => rate.promise,
      commit: () => {
        order.push("commit-started");
        return commit.promise;
      },
    })().then(() => order.push("provider"));
    await Promise.resolve();
    expect(order).toEqual(["commit-started"]);
    commit.resolve();
    await Promise.resolve();
    // An acknowledged lease alone does not release the provider call.
    expect(order).toEqual(["commit-started"]);
    rate.resolve(null);
    await boundary;
    expect(order).toEqual(["commit-started", "provider"]);
  });

  test("a rate denial surfaces with its response, ahead of a commit refusal", async () => {
    const denial = Response.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": "7" } },
    );
    let denied = 0;
    for (const commit of [
      async () => {},
      async () => {
        throw Error("insufficient credits");
      },
    ]) {
      const error = await joinProviderBoundary({
        signal: new AbortController().signal,
        rateVerdict: async () => denial,
        commit,
        onRateDenied: () => denied++,
      })().catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(OrgRateLimitedBeforeDispatchError);
      expect((error as OrgRateLimitedBeforeDispatchError).response).toBe(
        denial,
      );
    }
    expect(denied).toBe(2);
  });

  test("a commit refusal is preserved when the rate verdict allows", async () => {
    const refusal = Error("insufficient credits");
    await expect(
      joinProviderBoundary({
        signal: new AbortController().signal,
        rateVerdict: async () => null,
        commit: async () => {
          throw refusal;
        },
      })(),
    ).rejects.toBe(refusal);
  });

  test("a caller that already left commits nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    let commits = 0;
    await expect(
      joinProviderBoundary({
        signal: controller.signal,
        commit: async () => {
          commits++;
        },
      })(),
    ).rejects.toBeInstanceOf(ClientClosedBeforeDispatchError);
    expect(commits).toBe(0);
  });

  test("a caller that leaves during the commit never reaches the provider", async () => {
    const controller = new AbortController();
    await expect(
      joinProviderBoundary({
        signal: controller.signal,
        commit: async () => {
          controller.abort();
        },
      })(),
    ).rejects.toBeInstanceOf(ClientClosedBeforeDispatchError);
  });
});
