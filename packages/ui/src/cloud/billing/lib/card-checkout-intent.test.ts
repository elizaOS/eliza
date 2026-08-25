/**
 * Deterministic contract tests for cross-tab card-checkout intent coordination.
 *
 * In-memory Storage and Web Lock doubles exercise serialization, strict
 * persisted-state validation, compare-and-swap cleanup, and fail-closed browser
 * failures without making checkout or Stripe requests.
 */

import { describe, expect, it } from "vitest";
import {
  CARD_CHECKOUT_IDEMPOTENCY_KEY_PATTERN,
  CARD_CHECKOUT_INTENT_STORAGE_PREFIX,
  CARD_CHECKOUT_INTENT_TTL_MS,
  CARD_CHECKOUT_TAB_POINTER_STORAGE_KEY,
  CardCheckoutIntentCoordinationError,
  type CardCheckoutIntentLockManager,
  type CardCheckoutIntentStorage,
  cardCheckoutIntentStorageKey,
  createCardCheckoutIntentCoordinator,
} from "./card-checkout-intent";

const ORG_A = "org-a";
const ORG_B = "org-b";
const USER_A = "user-a";
const USER_B = "user-b";
const AMOUNT_A = 2_500;
const AMOUNT_B = 3_000;
const STARTED_AT = 1_800_000_000_000;

function uuid(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

class MemoryStorage implements CardCheckoutIntentStorage {
  protected readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  serializedValues(): string[] {
    return [...this.values.values()];
  }
}

class WriteReadMismatchStorage extends MemoryStorage {
  override setItem(_key: string, _value: string): void {
    // Deliberately acknowledge without persisting to model a broken proxy.
  }
}

class SerialLockManager implements CardCheckoutIntentLockManager {
  private tail: Promise<void> = Promise.resolve();
  active = 0;
  acquisitions = 0;

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
      throw new Error("lock request aborted");
    }
    this.active += 1;
    this.acquisitions += 1;
    try {
      return await callback();
    } finally {
      this.active -= 1;
      release();
    }
  }
}

class TimeoutLockManager implements CardCheckoutIntentLockManager {
  request<T>(
    _name: string,
    options: { mode: "exclusive"; signal: AbortSignal },
    _callback: () => T | PromiseLike<T>,
  ): Promise<T> {
    return new Promise<T>((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(new Error("lock request aborted")),
        { once: true },
      );
    });
  }
}

function harness(
  options: {
    localStorage?: CardCheckoutIntentStorage | null;
    sessionStorage?: CardCheckoutIntentStorage | null;
    lockManager?: CardCheckoutIntentLockManager | null;
    now?: () => number;
    randomUUID?: () => string;
    lockTimeoutMs?: number;
  } = {},
) {
  const localStorage =
    options.localStorage === undefined
      ? new MemoryStorage()
      : options.localStorage;
  const sessionStorage =
    options.sessionStorage === undefined
      ? new MemoryStorage()
      : options.sessionStorage;
  const lockManager =
    options.lockManager === undefined
      ? new SerialLockManager()
      : options.lockManager;
  let generated = 0;
  const randomUUID =
    options.randomUUID ??
    (() => {
      generated += 1;
      return uuid(generated);
    });
  const coordinator = createCardCheckoutIntentCoordinator({
    localStorage,
    sessionStorage,
    lockManager,
    now: options.now ?? (() => STARTED_AT),
    randomUUID,
    lockTimeoutMs: options.lockTimeoutMs,
  });
  return {
    coordinator,
    localStorage,
    sessionStorage,
    lockManager,
    generated: () => generated,
  };
}

async function expectCoordinationCode(
  promise: Promise<unknown>,
  code: string,
): Promise<CardCheckoutIntentCoordinationError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(CardCheckoutIntentCoordinationError);
  expect(error).toMatchObject({ code });
  return error as CardCheckoutIntentCoordinationError;
}

describe("card checkout intent reservation", () => {
  it("serializes concurrent actors so one organization and amount mint one UUID", async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const lockManager = new SerialLockManager();
    let generated = 0;
    const dependencies = {
      localStorage,
      sessionStorage,
      lockManager,
      now: () => STARTED_AT,
      randomUUID: () => uuid(++generated),
    };
    const firstTab = createCardCheckoutIntentCoordinator(dependencies);
    const secondTab = createCardCheckoutIntentCoordinator(dependencies);

    const [first, second] = await Promise.all([
      firstTab.reserve({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
      }),
      secondTab.reserve({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
      }),
    ]);

    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.idempotencyKey).toMatch(CARD_CHECKOUT_IDEMPOTENCY_KEY_PATTERN);
    expect(generated).toBe(1);
    expect(lockManager).toMatchObject({ acquisitions: 2, active: 0 });
  });

  it("reuses the same key after a coordinator reload", async () => {
    const sharedLocalStorage = new MemoryStorage();
    const sharedSessionStorage = new MemoryStorage();
    const sharedLockManager = new SerialLockManager();
    let generated = 0;
    const dependencies = {
      localStorage: sharedLocalStorage,
      sessionStorage: sharedSessionStorage,
      lockManager: sharedLockManager,
      now: () => STARTED_AT,
      randomUUID: () => uuid(++generated),
    };
    const beforeReload = createCardCheckoutIntentCoordinator(dependencies);
    const first = await beforeReload.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });

    const afterReload = createCardCheckoutIntentCoordinator(dependencies);
    const replay = await afterReload.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });

    expect(replay).toEqual(first);
    expect(generated).toBe(1);
  });

  it("keeps one slot and rotates all three keys across A -> B -> A", async () => {
    const { coordinator, localStorage, generated } = harness();

    const firstA = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    const middleB = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_B,
    });
    const finalA = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });

    expect(
      new Set([
        firstA.idempotencyKey,
        middleB.idempotencyKey,
        finalA.idempotencyKey,
      ]),
    ).toHaveLength(3);
    expect(generated()).toBe(3);
    expect(localStorage?.length).toBe(1);
    expect(localStorage?.key(0)).toBe(cardCheckoutIntentStorageKey(ORG_A));
  });

  it("isolates one intent slot per organization", async () => {
    const { coordinator, localStorage } = harness();

    const [first, second] = await Promise.all([
      coordinator.reserve({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
      }),
      coordinator.reserve({
        organizationId: ORG_B,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
      }),
    ]);

    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(localStorage?.length).toBe(2);
    expect(
      localStorage?.getItem(cardCheckoutIntentStorageKey(ORG_A)),
    ).not.toBeNull();
    expect(
      localStorage?.getItem(cardCheckoutIntentStorageKey(ORG_B)),
    ).not.toBeNull();
  });

  it("pins the 25-hour boundary, reuses stale same-amount, and blocks stale amount changes", async () => {
    let now = STARTED_AT;
    const { coordinator, generated } = harness({ now: () => now });
    const original = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    expect(original.createdAt).toBe(STARTED_AT);
    expect(original.staleAt).toBe(STARTED_AT + CARD_CHECKOUT_INTENT_TTL_MS);

    now = original.staleAt;
    const staleReplay = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    expect(staleReplay).toEqual(original);
    expect(generated()).toBe(1);

    await expectCoordinationCode(
      coordinator.reserve({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_B,
      }),
      "CARD_CHECKOUT_COORDINATION_STALE_AMOUNT_CONFLICT",
    );
    expect(generated()).toBe(1);
  });

  it("rotates the organization slot when another user submits the same amount", async () => {
    const { coordinator, localStorage, generated } = harness();
    const firstUser = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    const secondUser = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_B,
      amountCents: AMOUNT_A,
    });

    expect(secondUser.idempotencyKey).not.toBe(firstUser.idempotencyKey);
    expect(secondUser.initiatedByUserId).toBe(USER_B);
    expect(generated()).toBe(2);
    expect(
      JSON.parse(
        localStorage?.getItem(cardCheckoutIntentStorageKey(ORG_A)) ?? "null",
      ),
    ).toMatchObject({
      initiatedByUserId: USER_B,
      amountCents: AMOUNT_A,
      idempotencyKey: secondUser.idempotencyKey,
    });
  });

  it("rotates a stale organization slot on account switch instead of replaying the prior user", async () => {
    let now = STARTED_AT;
    const { coordinator, generated } = harness({ now: () => now });
    const firstUser = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    now = firstUser.staleAt;

    const secondUser = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_B,
      amountCents: AMOUNT_B,
    });

    expect(secondUser.idempotencyKey).not.toBe(firstUser.idempotencyKey);
    expect(secondUser).toMatchObject({
      initiatedByUserId: USER_B,
      amountCents: AMOUNT_B,
      createdAt: firstUser.staleAt,
    });
    expect(generated()).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe amountCents boundary value %s",
    async (amountCents) => {
      const { coordinator } = harness();
      await expectCoordinationCode(
        coordinator.reserve({
          organizationId: ORG_A,
          initiatedByUserId: USER_A,
          amountCents,
        }),
        "CARD_CHECKOUT_COORDINATION_INVALID_INPUT",
      );
    },
  );
});

describe("card checkout intent compare-and-swap lifecycle", () => {
  it("supersedes late bind and rejection callbacks from the prior account", async () => {
    const { coordinator, localStorage } = harness();
    const firstUser = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    const secondUser = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_B,
      amountCents: AMOUNT_A,
    });

    await expect(
      coordinator.bindSession({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
        idempotencyKey: firstUser.idempotencyKey,
        sessionId: "cs_test_old_account",
      }),
    ).resolves.toEqual({ status: "superseded" });
    await expect(
      coordinator.clearDefinitiveRejection({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
        idempotencyKey: firstUser.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "superseded" });
    expect(
      JSON.parse(
        localStorage?.getItem(cardCheckoutIntentStorageKey(ORG_A)) ?? "null",
      ),
    ).toMatchObject({
      initiatedByUserId: USER_B,
      idempotencyKey: secondUser.idempotencyKey,
      sessionId: null,
    });
  });

  it("reports a stale bind and rejection clear as superseded without touching K2", async () => {
    const { coordinator, localStorage } = harness();
    const first = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    const newer = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_B,
    });

    await expect(
      coordinator.bindSession({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
        idempotencyKey: first.idempotencyKey,
        sessionId: "cs_test_stale",
      }),
    ).resolves.toEqual({ status: "superseded" });
    await expect(
      coordinator.clearDefinitiveRejection({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
        idempotencyKey: first.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "superseded" });

    const persisted = JSON.parse(
      localStorage?.getItem(cardCheckoutIntentStorageKey(ORG_A)) ?? "null",
    );
    expect(persisted).toMatchObject({
      amountCents: AMOUNT_B,
      idempotencyKey: newer.idempotencyKey,
      sessionId: null,
    });
  });

  it("clears only the exact unbound intent after a definitive rejection", async () => {
    const { coordinator, localStorage } = harness();
    const intent = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });

    await expect(
      coordinator.clearDefinitiveRejection({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
        idempotencyKey: intent.idempotencyKey,
      }),
    ).resolves.toEqual({ status: "cleared" });
    expect(
      localStorage?.getItem(cardCheckoutIntentStorageKey(ORG_A)),
    ).toBeNull();
  });

  it("binds a session exactly and clears it from the tab pointer first", async () => {
    const { coordinator, localStorage, sessionStorage } = harness();
    const intent = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    const bound = await coordinator.bindSession({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
      idempotencyKey: intent.idempotencyKey,
      sessionId: "cs_test_bound",
    });
    expect(bound).toMatchObject({
      status: "bound",
      intent: { sessionId: "cs_test_bound" },
    });
    expect(
      sessionStorage?.getItem(CARD_CHECKOUT_TAB_POINTER_STORAGE_KEY),
    ).not.toBeNull();

    await expect(
      coordinator.clearVerifiedSession({ sessionId: "cs_test_bound" }),
    ).resolves.toEqual({ status: "cleared", source: "tab-pointer" });
    expect(
      localStorage?.getItem(cardCheckoutIntentStorageKey(ORG_A)),
    ).toBeNull();
    expect(
      sessionStorage?.getItem(CARD_CHECKOUT_TAB_POINTER_STORAGE_KEY),
    ).toBeNull();
  });

  it("falls back to an exact namespace scan when the returning tab has no pointer", async () => {
    const sharedLocalStorage = new MemoryStorage();
    const creatingTab = harness({ localStorage: sharedLocalStorage });
    const intent = await creatingTab.coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    await creatingTab.coordinator.bindSession({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
      idempotencyKey: intent.idempotencyKey,
      sessionId: "cs_test_scan",
    });

    const returningTab = harness({
      localStorage: sharedLocalStorage,
      sessionStorage: new MemoryStorage(),
      randomUUID: () => uuid(99),
    });
    await expect(
      returningTab.coordinator.clearVerifiedSession({
        sessionId: "cs_test_scan",
      }),
    ).resolves.toEqual({ status: "cleared", source: "namespace-scan" });
    expect(sharedLocalStorage.length).toBe(0);
  });

  it("does not clear a newer K2 when verified K1 returns", async () => {
    const { coordinator, localStorage, sessionStorage } = harness();
    const first = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    await coordinator.bindSession({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
      idempotencyKey: first.idempotencyKey,
      sessionId: "cs_test_old",
    });
    const newer = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_B,
    });

    await expect(
      coordinator.clearVerifiedSession({ sessionId: "cs_test_old" }),
    ).resolves.toEqual({ status: "not-found" });
    const persisted = JSON.parse(
      localStorage?.getItem(cardCheckoutIntentStorageKey(ORG_A)) ?? "null",
    );
    expect(persisted).toMatchObject({
      amountCents: AMOUNT_B,
      idempotencyKey: newer.idempotencyKey,
      sessionId: null,
    });
    expect(
      sessionStorage?.getItem(CARD_CHECKOUT_TAB_POINTER_STORAGE_KEY),
    ).toBeNull();
  });

  it("fails closed if one key is rebound to a different session", async () => {
    const { coordinator } = harness();
    const intent = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    const exact = {
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
      idempotencyKey: intent.idempotencyKey,
    };
    await coordinator.bindSession({ ...exact, sessionId: "cs_test_first" });

    await expectCoordinationCode(
      coordinator.bindSession({ ...exact, sessionId: "cs_test_second" }),
      "CARD_CHECKOUT_COORDINATION_SESSION_MISMATCH",
    );
  });
});

describe("card checkout intent fail-closed boundaries", () => {
  it("rejects strict-schema corruption instead of replacing it", async () => {
    const localStorage = new MemoryStorage();
    localStorage.setItem(cardCheckoutIntentStorageKey(ORG_A), "{not-json");
    const { coordinator } = harness({ localStorage });

    await expectCoordinationCode(
      coordinator.reserve({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
      }),
      "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
    );
    expect(localStorage.getItem(cardCheckoutIntentStorageKey(ORG_A))).toBe(
      "{not-json",
    );
  });

  it("rejects an extra persisted URL field under the strict v1 schema", async () => {
    const localStorage = new MemoryStorage();
    localStorage.setItem(
      cardCheckoutIntentStorageKey(ORG_A),
      JSON.stringify({
        version: 1,
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
        idempotencyKey: uuid(1),
        createdAt: STARTED_AT,
        staleAt: STARTED_AT + CARD_CHECKOUT_INTENT_TTL_MS,
        sessionId: null,
        checkoutUrl: "https://checkout.stripe.example/forbidden",
      }),
    );
    const { coordinator } = harness({ localStorage });

    await expectCoordinationCode(
      coordinator.reserve({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
      }),
      "CARD_CHECKOUT_COORDINATION_STORAGE_CORRUPT",
    );
  });

  it("blocks when localStorage is unavailable", async () => {
    const { coordinator } = harness({ localStorage: null });
    await expectCoordinationCode(
      coordinator.reserve({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
      }),
      "CARD_CHECKOUT_COORDINATION_STORAGE_UNAVAILABLE",
    );
  });

  it("binds with unavailable sessionStorage and cleans up by namespace scan", async () => {
    const localStorage = new MemoryStorage();
    const initial = harness({ localStorage });
    const intent = await initial.coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    const withoutSessionStorage = harness({
      localStorage,
      sessionStorage: null,
      randomUUID: () => uuid(99),
    });

    await expect(
      withoutSessionStorage.coordinator.bindSession({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
        idempotencyKey: intent.idempotencyKey,
        sessionId: "cs_test_storage_missing",
      }),
    ).resolves.toMatchObject({
      status: "bound",
      intent: { sessionId: "cs_test_storage_missing" },
    });
    expect(
      JSON.parse(
        localStorage.getItem(cardCheckoutIntentStorageKey(ORG_A)) ?? "null",
      ),
    ).toMatchObject({ sessionId: "cs_test_storage_missing" });
    await expect(
      withoutSessionStorage.coordinator.clearVerifiedSession({
        sessionId: "cs_test_storage_missing",
      }),
    ).resolves.toEqual({ status: "cleared", source: "namespace-scan" });
    expect(localStorage.length).toBe(0);
  });

  it("ignores a corrupt best-effort tab pointer and cleans up by namespace scan", async () => {
    const { coordinator, localStorage, sessionStorage } = harness();
    const intent = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    await coordinator.bindSession({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
      idempotencyKey: intent.idempotencyKey,
      sessionId: "cs_test_corrupt_pointer",
    });
    sessionStorage?.setItem(CARD_CHECKOUT_TAB_POINTER_STORAGE_KEY, "{broken");

    await expect(
      coordinator.clearVerifiedSession({
        sessionId: "cs_test_corrupt_pointer",
      }),
    ).resolves.toEqual({ status: "cleared", source: "namespace-scan" });
    expect(localStorage?.length).toBe(0);
  });

  it("blocks when Web Locks are unavailable", async () => {
    const { coordinator } = harness({ lockManager: null });
    await expectCoordinationCode(
      coordinator.reserve({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
      }),
      "CARD_CHECKOUT_COORDINATION_LOCK_UNAVAILABLE",
    );
  });

  it("bounds lock acquisition and reports a typed timeout", async () => {
    const { coordinator } = harness({
      lockManager: new TimeoutLockManager(),
      lockTimeoutMs: 5,
    });
    await expectCoordinationCode(
      coordinator.reserve({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
      }),
      "CARD_CHECKOUT_COORDINATION_LOCK_TIMEOUT",
    );
  });

  it("blocks when storage cannot round-trip a newly reserved intent", async () => {
    const { coordinator } = harness({
      localStorage: new WriteReadMismatchStorage(),
    });
    await expectCoordinationCode(
      coordinator.reserve({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
      }),
      "CARD_CHECKOUT_COORDINATION_STORAGE_ROUNDTRIP_MISMATCH",
    );
  });

  it("blocks an injected UUID that violates the server regex", async () => {
    const { coordinator } = harness({ randomUUID: () => "bad" });
    await expectCoordinationCode(
      coordinator.reserve({
        organizationId: ORG_A,
        initiatedByUserId: USER_A,
        amountCents: AMOUNT_A,
      }),
      "CARD_CHECKOUT_COORDINATION_INVALID_INPUT",
    );
  });

  it("performs every persisted-state operation while the global lock is active", async () => {
    const lockManager = new SerialLockManager();
    class GuardedStorage extends MemoryStorage {
      private assertLocked(): void {
        expect(lockManager.active).toBe(1);
      }

      override get length(): number {
        this.assertLocked();
        return super.length;
      }

      override getItem(key: string): string | null {
        this.assertLocked();
        return super.getItem(key);
      }

      override key(index: number): string | null {
        this.assertLocked();
        return super.key(index);
      }

      override removeItem(key: string): void {
        this.assertLocked();
        super.removeItem(key);
      }

      override setItem(key: string, value: string): void {
        this.assertLocked();
        super.setItem(key, value);
      }
    }
    const localStorage = new GuardedStorage();
    const sessionStorage = new GuardedStorage();
    const coordinator = createCardCheckoutIntentCoordinator({
      localStorage,
      sessionStorage,
      lockManager,
      now: () => STARTED_AT,
      randomUUID: () => uuid(1),
    });
    const intent = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    await coordinator.bindSession({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
      idempotencyKey: intent.idempotencyKey,
      sessionId: "cs_test_locked",
    });
    await coordinator.clearVerifiedSession({ sessionId: "cs_test_locked" });
    expect(lockManager.active).toBe(0);
  });

  it("never serializes a checkout URL in coordinator-owned storage", async () => {
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    const { coordinator } = harness({ localStorage, sessionStorage });
    const intent = await coordinator.reserve({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
    });
    await coordinator.bindSession({
      organizationId: ORG_A,
      initiatedByUserId: USER_A,
      amountCents: AMOUNT_A,
      idempotencyKey: intent.idempotencyKey,
      sessionId: "cs_test_redacted",
    });

    const serialized = [
      ...localStorage.serializedValues(),
      ...sessionStorage.serializedValues(),
    ].join("\n");
    expect(serialized).not.toMatch(/https?:\/\//i);
    expect(serialized.toLowerCase()).not.toContain("url");
    expect(
      [...Array(localStorage.length)].map((_, index) =>
        localStorage.key(index),
      ),
    ).toEqual([
      expect.stringMatching(
        new RegExp(`^${CARD_CHECKOUT_INTENT_STORAGE_PREFIX}`),
      ),
    ]);
  });
});
