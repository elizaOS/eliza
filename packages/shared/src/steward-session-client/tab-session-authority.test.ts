/** Deterministic two-context Steward tab-session authority contract. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { STEWARD_TOKEN_KEY } from "./index";
import {
  createStewardTabSessionAuthorityCoordinator,
  isOriginWideStewardSessionAuthorityAvailable,
  resetStewardTabSessionAuthorityCoordinatorForTests,
  STEWARD_LOGOUT_GENERATION_KEY,
  StewardSessionAuthorityError,
  type StewardSessionAuthorityLockManager,
  type StewardSessionAuthorityStorage,
  type StewardTabSessionAuthorityCoordinator,
} from "./tab-session-authority";

class MemoryStorage implements StewardSessionAuthorityStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class SerialLockManager implements StewardSessionAuthorityLockManager {
  private tail: Promise<void> = Promise.resolve();

  async request<T>(
    _name: string,
    options: { mode: "exclusive"; signal: AbortSignal },
    callback: () => T | PromiseLike<T>,
  ): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    if (options.signal.aborted) {
      release();
      throw new DOMException("Aborted", "AbortError");
    }
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

function twoTabs(): {
  storage: MemoryStorage;
  tabA: StewardTabSessionAuthorityCoordinator;
  tabB: StewardTabSessionAuthorityCoordinator;
} {
  const storage = new MemoryStorage();
  const locks = new SerialLockManager();
  const deps = { storage, lockManager: locks, timeoutMs: 250 };
  return {
    storage,
    tabA: createStewardTabSessionAuthorityCoordinator(deps),
    tabB: createStewardTabSessionAuthorityCoordinator(deps),
  };
}

afterEach(() => {
  resetStewardTabSessionAuthorityCoordinatorForTests();
});

describe("origin-wide availability", () => {
  it("is false in jsdom without Web Locks so automatic SSO can fail closed", () => {
    expect(isOriginWideStewardSessionAuthorityAvailable()).toBe(false);
    expect(
      createStewardTabSessionAuthorityCoordinator({
        storage: new MemoryStorage(),
        lockManager: null,
      }).originWide,
    ).toBe(false);
  });

  it("refuses exclusive work that requires origin-wide coordination", async () => {
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage: new MemoryStorage(),
      lockManager: null,
    });
    await expect(
      coordinator.runExclusive({
        kind: "session-sync",
        requireOriginWide: true,
        work: async () => "ok",
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_UNAVAILABLE",
    });
  });
});

describe("two-context Steward session authority", () => {
  it("does not persist a token when logout wins during persistence", async () => {
    const { storage, tabA, tabB } = twoTabs();
    storage.setItem(STEWARD_TOKEN_KEY, "token-a");
    let releaseLogout!: () => void;
    const logoutHold = new Promise<void>((resolve) => {
      releaseLogout = resolve;
    });

    const logout = tabB.runExclusive({
      kind: "logout",
      expectedToken: "token-a",
      work: async (ctx) => {
        await logoutHold;
        ctx.revalidate();
        ctx.advanceLogoutGeneration();
        storage.removeItem(STEWARD_TOKEN_KEY);
        ctx.noteToken(null);
      },
    });
    await Promise.resolve();

    const persist = tabA.runExclusive({
      kind: "token-write",
      expectedToken: "token-a",
      work: async (ctx) => {
        ctx.revalidate();
        storage.setItem(STEWARD_TOKEN_KEY, "token-a-persisted");
        ctx.noteToken("token-a-persisted");
      },
    });

    releaseLogout();
    await logout;
    await expect(persist).rejects.toBeInstanceOf(StewardSessionAuthorityError);
    expect(storage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
    expect(storage.getItem(STEWARD_LOGOUT_GENERATION_KEY)).toMatch(/^1:/);
  });

  it("does not finish a stale token-to-cookie POST after logout", async () => {
    const { storage, tabA, tabB } = twoTabs();
    storage.setItem(STEWARD_TOKEN_KEY, "token-a");
    const cookieMutations: string[] = [];
    const expected = tabA.readSnapshot();

    await tabB.runExclusive({
      kind: "logout",
      expectedToken: "token-a",
      work: async (ctx) => {
        ctx.advanceLogoutGeneration();
        storage.removeItem(STEWARD_TOKEN_KEY);
        ctx.noteToken(null);
        cookieMutations.push("DELETE after logout");
      },
    });

    await expect(
      tabA.runExclusive({
        kind: "session-sync",
        expectedToken: expected.token,
        expectedGeneration: expected.generation,
        work: async (ctx) => {
          ctx.revalidate();
          cookieMutations.push("POST token-a");
        },
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
    });
    expect(cookieMutations).toEqual(["DELETE after logout"]);
  });

  it("keeps localStorage and the final cookie mutation on the same account", async () => {
    const { storage, tabA, tabB } = twoTabs();
    const cookieMutations: string[] = [];
    const snapshotA = { token: "token-a", generation: tabA.readGeneration() };

    await tabB.runExclusive({
      kind: "session-sync",
      work: async (ctx) => {
        ctx.revalidate();
        storage.setItem(STEWARD_TOKEN_KEY, "token-b");
        ctx.noteToken("token-b");
        cookieMutations.push("cookie-b");
      },
    });

    await expect(
      tabA.runExclusive({
        kind: "session-sync",
        expectedToken: snapshotA.token,
        expectedGeneration: snapshotA.generation,
        work: async (ctx) => {
          ctx.revalidate();
          cookieMutations.push("cookie-a");
        },
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
    });
    expect(storage.getItem(STEWARD_TOKEN_KEY)).toBe("token-b");
    expect(cookieMutations).toEqual(["cookie-b"]);
  });

  it("rejects ABA logout then login then stale resume", async () => {
    const { storage, tabA, tabB } = twoTabs();
    storage.setItem(STEWARD_TOKEN_KEY, "token-old");
    const stale = tabA.readSnapshot();

    await tabB.runExclusive({
      kind: "logout",
      expectedToken: "token-old",
      work: async (ctx) => {
        ctx.advanceLogoutGeneration();
        storage.removeItem(STEWARD_TOKEN_KEY);
        ctx.noteToken(null);
      },
    });
    const generationAfterLogout = tabB.readGeneration();
    await tabB.runExclusive({
      kind: "token-write",
      expectedGeneration: generationAfterLogout,
      work: async (ctx) => {
        ctx.revalidate();
        storage.setItem(STEWARD_TOKEN_KEY, "token-fresh");
        ctx.noteToken("token-fresh");
      },
    });
    expect(tabB.readGeneration()).toBe(generationAfterLogout);

    await expect(
      tabA.runExclusive({
        kind: "callback-restore",
        expectedToken: stale.token,
        expectedGeneration: stale.generation,
        work: async (ctx) => {
          ctx.revalidate();
          storage.setItem(STEWARD_TOKEN_KEY, "token-old-resumed");
          ctx.noteToken("token-old-resumed");
        },
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
    });
    expect(storage.getItem(STEWARD_TOKEN_KEY)).toBe("token-fresh");
    expect(storage.getItem(STEWARD_LOGOUT_GENERATION_KEY)).toBe(
      generationAfterLogout,
    );
  });

  it("does not let a stale passive sync clear a newer tab token", async () => {
    const { storage, tabA, tabB } = twoTabs();
    storage.setItem(STEWARD_TOKEN_KEY, "token-a");
    const stale = tabA.readSnapshot();

    await tabB.runExclusive({
      kind: "token-write",
      work: async (ctx) => {
        ctx.revalidate();
        storage.setItem(STEWARD_TOKEN_KEY, "token-b");
        ctx.noteToken("token-b");
      },
    });

    await expect(
      tabA.runExclusive({
        kind: "passive-mirror",
        expectedToken: stale.token,
        expectedGeneration: stale.generation,
        work: async (ctx) => {
          ctx.revalidate();
          storage.removeItem(STEWARD_TOKEN_KEY);
          ctx.noteToken(null);
        },
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
    });
    expect(storage.getItem(STEWARD_TOKEN_KEY)).toBe("token-b");
  });

  it("does not apply a refresh response after logout", async () => {
    const { storage, tabA, tabB } = twoTabs();
    storage.setItem(STEWARD_TOKEN_KEY, "token-a");
    const stale = tabA.readSnapshot();

    await tabB.runExclusive({
      kind: "logout",
      expectedToken: "token-a",
      work: async (ctx) => {
        ctx.advanceLogoutGeneration();
        storage.removeItem(STEWARD_TOKEN_KEY);
        ctx.noteToken(null);
      },
    });

    await expect(
      tabA.runExclusive({
        kind: "refresh",
        expectedToken: stale.token,
        expectedGeneration: stale.generation,
        work: async (ctx) => {
          ctx.revalidate();
          storage.setItem(STEWARD_TOKEN_KEY, "token-refreshed");
          ctx.noteToken("token-refreshed");
        },
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
    });
    expect(storage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it("skips a stale cookie DELETE after a newer login", async () => {
    const { storage, tabA, tabB } = twoTabs();
    storage.setItem(STEWARD_TOKEN_KEY, "token-a");
    const cookieMutations: string[] = [];

    await tabA.runExclusive({
      kind: "logout",
      expectedToken: "token-a",
      work: async (ctx) => {
        ctx.advanceLogoutGeneration();
        storage.removeItem(STEWARD_TOKEN_KEY);
        ctx.noteToken(null);
      },
    });
    const logoutGeneration = tabA.readGeneration();

    await tabB.runExclusive({
      kind: "session-sync",
      expectedGeneration: logoutGeneration,
      work: async (ctx) => {
        ctx.revalidate();
        storage.setItem(STEWARD_TOKEN_KEY, "token-b");
        ctx.noteToken("token-b");
        cookieMutations.push("POST token-b");
      },
    });

    await expect(
      tabA.runExclusive({
        kind: "cookie-delete",
        expectedGeneration: logoutGeneration,
        requireTokenAbsent: true,
        work: async (ctx) => {
          ctx.revalidate();
          cookieMutations.push("DELETE");
        },
      }),
    ).rejects.toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
    });
    expect(cookieMutations).toEqual(["POST token-b"]);
    expect(storage.getItem(STEWARD_TOKEN_KEY)).toBe("token-b");
  });

  it("releases a hung exclusive so the next tab is not stranded", async () => {
    const { tabA, tabB } = twoTabs();
    const hung = tabA.runExclusive({
      kind: "session-sync",
      timeoutMs: 40,
      work: async ({ signal }) => {
        await new Promise<void>((_resolve, reject) => {
          const timer = setTimeout(() => _resolve(), 1000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(
                new StewardSessionAuthorityError(
                  "Steward session authority timed out.",
                  "STEWARD_SESSION_AUTHORITY_TIMEOUT",
                ),
              );
            },
            { once: true },
          );
        });
      },
    });
    await expect(hung).rejects.toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_TIMEOUT",
    });
    await expect(
      tabB.runExclusive({
        kind: "logout",
        work: async (ctx) => {
          ctx.advanceLogoutGeneration();
          return tabB.readGeneration();
        },
      }),
    ).resolves.toMatch(/^1:/);
  });

  it("rejects a stale op captured before logout even when the same token is restored", async () => {
    const { storage, tabA, tabB } = twoTabs();
    storage.setItem(STEWARD_TOKEN_KEY, "token-a");
    const stale = tabA.readSnapshot();

    await tabB.runExclusive({
      kind: "logout",
      expectedToken: "token-a",
      work: async (ctx) => {
        ctx.advanceLogoutGeneration();
        storage.removeItem(STEWARD_TOKEN_KEY);
        ctx.noteToken(null);
      },
    });
    await tabB.runExclusive({
      kind: "token-write",
      work: async (ctx) => {
        ctx.revalidate();
        storage.setItem(STEWARD_TOKEN_KEY, "token-a");
        ctx.noteToken("token-a");
      },
    });

    await expect(
      tabA.runExclusive({
        kind: "callback-restore",
        expectedToken: stale.token,
        expectedGeneration: stale.generation,
        work: async (ctx) => {
          ctx.revalidate();
          storage.setItem(STEWARD_TOKEN_KEY, "token-a-stale-applied");
          ctx.noteToken("token-a-stale-applied");
        },
      }),
    ).rejects.toBeInstanceOf(StewardSessionAuthorityError);
    expect(storage.getItem(STEWARD_TOKEN_KEY)).toBe("token-a");
  });

  it("serializes independent same-realm runExclusive calls instead of reentering via ambient hold state", async () => {
    const storage = new MemoryStorage();
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage,
      lockManager: new SerialLockManager(),
      timeoutMs: 250,
    });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = coordinator.runExclusive({
      kind: "session-sync",
      work: async () => {
        order.push("first:start");
        await firstHold;
        order.push("first:end");
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const second = coordinator.runExclusive({
      kind: "logout",
      work: async () => {
        order.push("second");
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("runs nested work through the hold helper without deadlocking fire-and-forget callers", async () => {
    const storage = new MemoryStorage();
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage,
      lockManager: new SerialLockManager(),
      timeoutMs: 250,
    });
    const order: string[] = [];
    let releaseOuter!: () => void;
    const outerHold = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });

    const outer = coordinator.runExclusive({
      kind: "session-sync",
      work: async (ctx) => {
        order.push("outer:start");
        await ctx.runExclusive({
          kind: "token-write",
          work: async () => {
            order.push("nested");
          },
        });
        await outerHold;
        order.push("outer:end");
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    let fireDone = false;
    void coordinator
      .runExclusive({
        kind: "cookie-delete",
        work: async () => {
          order.push("voided");
        },
      })
      .then(() => {
        fireDone = true;
      });
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["outer:start", "nested"]);
    expect(fireDone).toBe(false);
    releaseOuter();
    await outer;
    await vi.waitFor(() => {
      expect(fireDone).toBe(true);
    });
    expect(order).toEqual(["outer:start", "nested", "outer:end", "voided"]);
  });
});

describe("fallback lock waiter drain", () => {
  it("lets waiter C run after A holds and B expires while queued", async () => {
    const storage = new MemoryStorage();
    const coordinator = createStewardTabSessionAuthorityCoordinator({
      storage,
      lockManager: null,
      timeoutMs: 500,
    });
    const order: string[] = [];
    let releaseA!: () => void;
    const aHold = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const a = coordinator.runExclusive({
      kind: "session-sync",
      timeoutMs: 1000,
      work: async () => {
        order.push("A:start");
        await aHold;
        order.push("A:end");
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    const b = coordinator.runExclusive({
      kind: "logout",
      timeoutMs: 40,
      work: async () => {
        order.push("B");
      },
    });
    const c = coordinator.runExclusive({
      kind: "token-write",
      timeoutMs: 500,
      work: async () => {
        order.push("C");
      },
    });

    await expect(b).rejects.toMatchObject({
      code: "STEWARD_SESSION_AUTHORITY_TIMEOUT",
    });
    expect(order).toEqual(["A:start"]);
    releaseA();
    await a;
    await c;
    expect(order).toEqual(["A:start", "A:end", "C"]);
  });
});
