/** Deterministic coordinator contracts; the app browser probe owns real-tab coverage. */
import { describe, expect, it } from "vitest";
import { STEWARD_TOKEN_KEY } from "./session-keys";
import {
  createStewardTabSessionAuthorityCoordinator,
  type StewardSessionAuthorityLockManager,
  type StewardSessionAuthorityWorkContext,
} from "./tab-session-authority";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function sharedLocks(): StewardSessionAuthorityLockManager {
  let tail = Promise.resolve();
  return {
    request(_name, { signal }, work) {
      const result = tail.then(() => {
        if (signal.aborted) throw new Error("Aborted lock request");
        return work();
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

describe("origin-wide session authority", () => {
  it("does not publish a token when cancellation precedes its final synchronous commit", async () => {
    const store = storage();
    const controller = new AbortController();
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: store,
    });
    await expect(
      coordinator.runExclusive({
        kind: "token-write",
        signal: controller.signal,
        work: async (ctx) => {
          controller.abort();
          ctx.completeTokenWrite("cancelled", () =>
            store.setItem(STEWARD_TOKEN_KEY, "cancelled"),
          );
        },
      }),
    ).rejects.toMatchObject({ code: "STEWARD_SESSION_AUTHORITY_CANCELLED" });
    expect(store.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("retains parent cancellation checks after a child token write has committed", async () => {
    const store = storage();
    const controller = new AbortController();
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: store,
    });
    let childCompleted = false;
    let parentPublished = false;
    await expect(
      coordinator.runExclusive({
        kind: "callback-restore",
        signal: controller.signal,
        work: async (parent) => {
          await parent.runExclusive({
            kind: "token-write",
            work: async (child) => {
              child.completeTokenWrite("committed", () =>
                store.setItem(STEWARD_TOKEN_KEY, "committed"),
              );
              queueMicrotask(() => controller.abort());
            },
          });
          childCompleted = true;
          parent.revalidate();
          parentPublished = true;
        },
      }),
    ).rejects.toMatchObject({ code: "STEWARD_SESSION_AUTHORITY_CANCELLED" });
    expect(childCompleted).toBe(true);
    expect(parentPublished).toBe(false);
    expect(store.getItem(STEWARD_TOKEN_KEY)).toBe("committed");
  });

  it("does not let other operation kinds bypass their remaining authority checks", async () => {
    const store = storage();
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: store,
    });
    await expect(
      coordinator.runExclusive({
        kind: "session-sync",
        work: async (ctx) =>
          ctx.completeTokenWrite("invalid", () =>
            store.setItem(STEWARD_TOKEN_KEY, "invalid"),
          ),
      }),
    ).rejects.toThrow("Only token-write work");
    expect(store.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("serializes independent realms through the supplied origin lock", async () => {
    const store = storage();
    const lockManager = sharedLocks();
    const a = createStewardTabSessionAuthorityCoordinator({
      storage: store,
      lockManager,
    });
    const b = createStewardTabSessionAuthorityCoordinator({
      storage: store,
      lockManager,
    });
    const held = gate();
    const entered = gate();
    const order: string[] = [];
    const first = a.runExclusive({
      kind: "session-sync",
      work: async () => {
        order.push("a");
        entered.release();
        await held.promise;
        order.push("a-done");
      },
    });
    await entered.promise;
    const second = b.runExclusive({
      kind: "session-sync",
      work: async () => {
        order.push("b");
      },
    });
    try {
      await Promise.resolve();
      expect(order).toEqual(["a"]);
    } finally {
      held.release();
      await Promise.all([first, second]);
    }
    expect(order).toEqual(["a", "a-done", "b"]);
  });

  it("rejects a pre-logout ticket even when a new login restores the same token", async () => {
    const store = storage();
    store.setItem(STEWARD_TOKEN_KEY, "same-token");
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: store,
      lockManager: sharedLocks(),
    });
    const old = coordinator.readSnapshot();
    await coordinator.runExclusive({
      kind: "logout",
      work: async (ctx) => {
        ctx.advanceLogoutGeneration();
        store.removeItem(STEWARD_TOKEN_KEY);
        ctx.noteToken(null);
      },
    });
    await coordinator.runExclusive({
      kind: "token-write",
      work: async (ctx) => {
        store.setItem(STEWARD_TOKEN_KEY, "same-token");
        ctx.noteToken("same-token");
      },
    });
    let ran = false;
    await expect(
      coordinator.runExclusive({
        kind: "callback-restore",
        expectedToken: old.token,
        expectedGeneration: old.generation,
        expectedScope: old.scope,
        work: async () => {
          ran = true;
        },
      }),
    ).rejects.toMatchObject({ code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED" });
    expect(ran).toBe(false);
  });

  it("settles a pre-aborted fallback waiter without stranding the holder or the next waiter", async () => {
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: storage(),
      lockManager: null,
    });
    const held = gate();
    const entered = gate();
    const first = coordinator.runExclusive({
      kind: "session-sync",
      work: async () => {
        entered.release();
        await held.promise;
      },
    });
    await entered.promise;
    const abort = new AbortController();
    abort.abort();
    try {
      await expect(
        coordinator.runExclusive({
          kind: "refresh",
          signal: abort.signal,
          work: async () => {
            throw new Error("Cancelled work must not run");
          },
        }),
      ).rejects.toMatchObject({ code: "STEWARD_SESSION_AUTHORITY_CANCELLED" });
    } finally {
      held.release();
      await first;
    }
    await expect(
      coordinator.runExclusive({ kind: "refresh", work: async () => "next" }),
    ).resolves.toBe("next");
  });

  it("permits only explicit nested work to reuse a held transaction", async () => {
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: storage(),
      lockManager: sharedLocks(),
    });
    await expect(
      coordinator.runExclusive({
        kind: "session-sync",
        work: async (ctx) =>
          ctx.runExclusive({
            kind: "token-write",
            work: async (nested) => {
              expect(nested.signal.aborted).toBe(false);
              return "nested";
            },
          }),
      }),
    ).resolves.toBe("nested");
  });

  it("fails closed when automatic work requires unavailable origin-wide coordination", async () => {
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: storage(),
      lockManager: null,
    });
    await expect(
      coordinator.runExclusive({
        kind: "refresh",
        requireOriginWide: true,
        work: async () => {
          throw new Error("Unavailable work must not run");
        },
      }),
    ).rejects.toMatchObject({ code: "STEWARD_SESSION_AUTHORITY_UNAVAILABLE" });
  });

  it("retains an authorized nested logout through cleanup failure without adopting unrelated changes", async () => {
    const store = storage();
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: store,
      lockManager: sharedLocks(),
    });
    store.setItem(STEWARD_TOKEN_KEY, "ending-session");
    const initial = coordinator.readSnapshot();
    const cleanupFailure = new Error("Legacy cleanup failed");
    await coordinator.runExclusive({
      kind: "logout",
      expectedToken: initial.token,
      work: async (outer) => {
        await expect(
          outer.runExclusive({
            kind: "logout",
            work: async (middle) =>
              middle.runExclusive({
                kind: "logout",
                work: async (inner) => {
                  inner.advanceLogoutGeneration();
                  store.removeItem(STEWARD_TOKEN_KEY);
                  inner.noteToken(null);
                  throw cleanupFailure;
                },
              }),
          }),
        ).rejects.toBe(cleanupFailure);
        const after = outer.revalidate();
        expect(after.token).toBeNull();
        expect(after.generation).not.toBe(initial.generation);
        store.setItem(STEWARD_TOKEN_KEY, "uncoordinated-session");
        expect(() => outer.revalidate()).toThrowError(
          expect.objectContaining({
            code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
          }),
        );
        store.removeItem(STEWARD_TOKEN_KEY);
      },
    });
  });

  it("bounds an abort-aware network operation and permits subsequent work", async () => {
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: storage(),
      lockManager: null,
    });
    await expect(
      coordinator.runExclusive({
        kind: "refresh",
        timeoutMs: 10,
        work: async (ctx) =>
          new Promise((_, reject) => {
            ctx.signal.addEventListener(
              "abort",
              () => reject(new Error("Fetch aborted")),
              { once: true },
            );
          }),
      }),
    ).rejects.toMatchObject({ code: "STEWARD_SESSION_AUTHORITY_TIMEOUT" });
    await expect(
      coordinator.runExclusive({ kind: "refresh", work: async () => "next" }),
    ).resolves.toBe("next");
  });

  it("classifies inaccessible canonical storage as authority failure", () => {
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: {
        ...storage(),
        getItem: () => {
          throw new Error("Storage denied");
        },
      },
      lockManager: sharedLocks(),
    });
    expect(() => coordinator.readSnapshot()).toThrowError(
      expect.objectContaining({
        code: "STEWARD_SESSION_AUTHORITY_STORAGE_FAILED",
      }),
    );
  });

  it("rejects reuse of a released transaction without changing logout authority", async () => {
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: storage(),
      lockManager: sharedLocks(),
    });
    let released!: StewardSessionAuthorityWorkContext;
    await coordinator.runExclusive({
      kind: "logout",
      work: async (ctx) => {
        released = ctx;
      },
    });
    const current = coordinator.readSnapshot();
    expect(() => released.advanceLogoutGeneration()).toThrowError(
      expect.objectContaining({ code: "STEWARD_SESSION_AUTHORITY_CANCELLED" }),
    );
    await expect(
      released.runExclusive({ kind: "token-write", work: async () => "stale" }),
    ).rejects.toMatchObject({ code: "STEWARD_SESSION_AUTHORITY_CANCELLED" });
    expect(coordinator.readSnapshot()).toEqual(current);
  });

  it.each(["cancel", "timeout"])(
    "bounds a nested %s without cancelling its parent transaction",
    async (reason) => {
      const coordinator = createStewardTabSessionAuthorityCoordinator({
        storage: storage(),
        lockManager: sharedLocks(),
      });
      await coordinator.runExclusive({
        kind: "session-sync",
        work: async (parent) => {
          const caller = new AbortController();
          const entered = gate();
          const child = parent.runExclusive({
            kind: "refresh",
            signal: caller.signal,
            timeoutMs: reason === "timeout" ? 10 : 1000,
            work: async (ctx) => {
              entered.release();
              await new Promise<void>((_, reject) => {
                ctx.signal.addEventListener(
                  "abort",
                  () => reject(new Error("Network aborted")),
                  { once: true },
                );
              });
            },
          });
          const result = expect(child).rejects.toMatchObject({
            code:
              reason === "cancel"
                ? "STEWARD_SESSION_AUTHORITY_CANCELLED"
                : "STEWARD_SESSION_AUTHORITY_TIMEOUT",
          });
          await entered.promise;
          if (reason === "cancel") caller.abort();
          await result;
          expect(parent.signal.aborted).toBe(false);
          parent.revalidate();
          await expect(
            parent.runExclusive({
              kind: "token-write",
              work: async () => "next",
            }),
          ).resolves.toBe("next");
        },
      });
    },
  );
});
