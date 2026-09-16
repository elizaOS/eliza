/** Exercises real shared session requests against delayed synthetic HTTP boundaries. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearStewardSession,
  clearStoredStewardToken,
  exchangeStewardCode,
  getStewardTabSessionAuthorityCoordinator,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_TOKEN_KEY,
  type SyncOpts,
  syncStewardSession,
  writeStoredStewardToken,
} from "./index";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function response() {
  return new Response(
    JSON.stringify({ ok: true, userId: "fixture", token: "fixture-token" }),
    {
      headers: { "content-type": "application/json" },
    },
  );
}

// Only the HTTP call is substituted; Bun's optional preconnect extension is
// outside this browser request contract.
function fetchFixture(
  implementation: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>,
): typeof fetch {
  return implementation as typeof fetch;
}

const requests = [
  {
    name: "session sync",
    run: (opts: SyncOpts) => syncStewardSession("fixture-token", null, opts),
  },
  {
    name: "nonce exchange",
    run: (opts: SyncOpts) => exchangeStewardCode("fixture-code", opts),
  },
];

afterEach(() => {
  localStorage.clear();
  resetStewardTabSessionAuthorityCoordinatorForTests();
});

describe.each(requests)("$name authority", ({ run }) => {
  it("does not dispatch work queued behind a logout with an older generation", async () => {
    const coordinator = getStewardTabSessionAuthorityCoordinator();
    const held = deferred();
    const entered = deferred();
    const blocker = coordinator.runExclusive({
      kind: "session-sync",
      work: async () => {
        entered.resolve();
        await held.promise;
      },
    });
    await entered.promise;
    const logout = clearStoredStewardToken();
    let dispatched = false;
    const attempt = run({
      fetchImpl: fetchFixture(async () => {
        dispatched = true;
        return response();
      }),
    }).then(
      () => null,
      (error: Error) => error,
    );
    held.resolve();
    await blocker;
    await logout;
    expect(await attempt).toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
    });
    expect(dispatched).toBe(false);
  });

  it("rejects a response belonging to authority replaced during the request", async () => {
    const held = deferred();
    const entered = deferred();
    const attempt = run({
      fetchImpl: fetchFixture(async () => {
        entered.resolve();
        await held.promise;
        return response();
      }),
    }).then(
      () => null,
      (error: Error) => error,
    );
    await entered.promise;
    // Simulate a legacy/uncoordinated context, not a production storage write.
    localStorage.setItem(STEWARD_TOKEN_KEY, "replacement-fixture");
    held.resolve();
    expect(await attempt).toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
    });
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("replacement-fixture");
  });

  it("honors caller cancellation and releases the hold after transport settlement", async () => {
    const controller = new AbortController();
    const entered = deferred();
    const held = deferred();
    let transportAborted = false;
    const attempt = run({
      signal: controller.signal,
      fetchImpl: fetchFixture(async (_url, init) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            transportAborted = true;
            held.resolve();
          },
          { once: true },
        );
        entered.resolve();
        await held.promise;
        return response();
      }),
    }).then(
      () => null,
      (error: Error) => error,
    );
    await entered.promise;
    controller.abort();
    // Also settle the old implementation so the RED test never hangs.
    held.resolve();
    expect(await attempt).toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_CANCELLED",
    });
    expect(transportAborted).toBe(true);
    await writeStoredStewardToken("next-fixture");
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("next-fixture");
  });

  it("bounds response-body consumption, not only receipt of headers", async () => {
    let streamAborted = false;
    const attempt = run({
      timeoutMs: 20,
      fetchImpl: fetchFixture(
        async (_url, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => {
                    streamAborted = true;
                    controller.error(new DOMException("Aborted", "AbortError"));
                  },
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    });
    await expect(attempt).rejects.toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_TIMEOUT",
    });
    expect(streamAborted).toBe(true);
    await writeStoredStewardToken("after-timeout-fixture");
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
      "after-timeout-fixture",
    );
  });

  it("keeps the parent's hold across a request and its canonical commit", async () => {
    const coordinator = getStewardTabSessionAuthorityCoordinator();
    await coordinator.runExclusive({
      kind: "callback-restore",
      work: async (authority) => {
        await run({
          authority,
          fetchImpl: fetchFixture(async () => response()),
        });
        authority.revalidate();
        await writeStoredStewardToken("committed-fixture", { authority });
      },
    });
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("committed-fixture");
  });
});

describe("cookie cleanup authority", () => {
  it("does not DELETE cookies while a current token exists", async () => {
    await writeStoredStewardToken("current-fixture");
    let dispatched = false;
    const attempt = Promise.resolve(
      clearStewardSession({
        fetchImpl: fetchFixture(async () => {
          dispatched = true;
          return response();
        }),
      }),
    ).then(
      () => null,
      (error: Error) => error,
    );
    expect(await attempt).toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
    });
    expect(dispatched).toBe(false);
  });

  it("waits for every cookie DELETE before allowing a new token write", async () => {
    const held = deferred();
    const entered = deferred();
    const cleanup = clearStewardSession({
      endpoints: ["/session-one", "/session-two"],
      fetchImpl: fetchFixture(async () => {
        entered.resolve();
        await held.promise;
        return response();
      }),
    });
    await entered.promise;
    const write = writeStoredStewardToken("next-fixture");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const tokenBeforeSettlement = localStorage.getItem(STEWARD_TOKEN_KEY);
    held.resolve();
    await cleanup;
    await write;
    expect(tokenBeforeSettlement).toBeNull();
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe("next-fixture");
  });

  it("reports a rejected DELETE instead of claiming cleanup succeeded", async () => {
    await expect(
      clearStewardSession({
        fetchImpl: fetchFixture(
          async () =>
            new Response(
              JSON.stringify({
                error: "Cookie cleanup rejected",
                code: "fixture-rejection",
              }),
              { status: 503, headers: { "content-type": "application/json" } },
            ),
        ),
      }),
    ).rejects.toMatchObject({
      name: "StewardSessionError",
      status: 503,
      code: "fixture-rejection",
    });
  });
});
