/** Deterministic two-context Steward tab-session authority contract. */
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
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
});
