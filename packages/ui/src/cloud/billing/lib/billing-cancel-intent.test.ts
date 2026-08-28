/**
 * Deterministic contract tests for cross-tab cancellation intent coordination.
 * Browser doubles exercise persistence, exact CAS behavior, and fail-closed
 * capability errors without issuing billing or provider requests.
 */

import { describe, expect, it } from "vitest";
import {
  BILLING_CANCEL_INTENT_STORAGE_PREFIX,
  BillingCancelIntentCoordinationError,
  type BillingCancelIntentDependencies,
  type BillingCancelIntentIdentity,
  type BillingCancelIntentLockManager,
  type BillingCancelIntentStorage,
  billingCancelIntentStorageKey,
  createBillingCancelIntentCoordinator,
} from "./billing-cancel-intent";

const ORGANIZATION_ID = "org-a";
const USER_ID = "user-a";
const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";
const RECEIPT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECEIPT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function uuid(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function identity(
  overrides: Partial<BillingCancelIntentIdentity> = {},
): BillingCancelIntentIdentity {
  return {
    organizationId: ORGANIZATION_ID,
    initiatedByUserId: USER_ID,
    resourceType: "container",
    resourceId: RESOURCE_ID,
    expectedLifecycleRevision: 7,
    endpoint: `/api/v1/billing/resources/${RESOURCE_ID}/cancel?resourceType=container`,
    ...overrides,
  };
}

function pollEndpoint(receiptId: string): string {
  return `/api/v1/billing/resources/${RESOURCE_ID}/cancel?receiptId=${receiptId}`;
}

class MemoryStorage implements BillingCancelIntentStorage {
  protected readonly values = new Map<string, string>();
  writes = 0;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }

  get size(): number {
    return this.values.size;
  }

  entries(): Array<[string, string]> {
    return [...this.values.entries()];
  }
}

class QuotaDeniedStorage extends MemoryStorage {
  override setItem(_key: string, _value: string): void {
    throw new DOMException("Quota exceeded", "QuotaExceededError");
  }
}

class SerialLockManager implements BillingCancelIntentLockManager {
  private tail: Promise<void> = Promise.resolve();
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
    this.acquisitions += 1;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

function harness(overrides: Partial<BillingCancelIntentDependencies> = {}) {
  const localStorage = overrides.localStorage ?? new MemoryStorage();
  const lockManager = overrides.lockManager ?? new SerialLockManager();
  let generated = 0;
  const randomUUID =
    overrides.randomUUID === undefined
      ? () => uuid(++generated)
      : overrides.randomUUID;
  const dependencies: BillingCancelIntentDependencies = {
    localStorage,
    lockManager,
    randomUUID,
    lockTimeoutMs: overrides.lockTimeoutMs,
  };
  return {
    coordinator: createBillingCancelIntentCoordinator(dependencies),
    dependencies,
    localStorage,
    lockManager,
    generated: () => generated,
  };
}

async function expectCoordinationCode(
  promise: Promise<unknown>,
  code: string,
): Promise<BillingCancelIntentCoordinationError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(BillingCancelIntentCoordinationError);
  expect(error).toMatchObject({ code });
  return error as BillingCancelIntentCoordinationError;
}

describe("billing cancellation intent reservation", () => {
  it("reuses one key across tabs and coordinator reloads for the exact identity", async () => {
    const shared = harness();
    const firstTab = shared.coordinator;
    const secondTab = createBillingCancelIntentCoordinator(shared.dependencies);

    const [first, second] = await Promise.all([
      firstTab.reserve(identity()),
      secondTab.reserve(identity()),
    ]);
    const afterReload = await createBillingCancelIntentCoordinator(
      shared.dependencies,
    ).reserve(identity());

    expect(second).toEqual(first);
    expect(afterReload).toEqual(first);
    expect(shared.generated()).toBe(1);
    expect(shared.lockManager).toMatchObject({ acquisitions: 3 });
    expect(shared.localStorage).toMatchObject({ size: 1 });
  });

  it("rotates an unbound slot when revision, user, or endpoint changes", async () => {
    const { coordinator, generated } = harness();
    const original = await coordinator.reserve(identity());
    const changedRevision = await coordinator.reserve(
      identity({ expectedLifecycleRevision: 8 }),
    );
    const changedUser = await coordinator.reserve(
      identity({ expectedLifecycleRevision: 8, initiatedByUserId: "user-b" }),
    );
    const changedEndpoint = await coordinator.reserve(
      identity({
        expectedLifecycleRevision: 8,
        initiatedByUserId: "user-b",
        endpoint: `/api/v2/billing/resources/${RESOURCE_ID}/cancel?resourceType=container`,
      }),
    );

    expect(
      new Set([
        original.idempotencyKey,
        changedRevision.idempotencyKey,
        changedUser.idempotencyKey,
        changedEndpoint.idempotencyKey,
      ]).size,
    ).toBe(4);
    expect(generated()).toBe(4);
    await expect(coordinator.readExact(identity())).resolves.toBeNull();
    await expect(
      coordinator.readExact(
        identity({
          expectedLifecycleRevision: 8,
          initiatedByUserId: "user-b",
          endpoint: `/api/v2/billing/resources/${RESOURCE_ID}/cancel?resourceType=container`,
        }),
      ),
    ).resolves.toEqual(changedEndpoint);
  });

  it("preserves a bound revision 7 receipt when revision 8 authority arrives", async () => {
    const { coordinator, generated, localStorage } = harness();
    const revision7 = await coordinator.reserve(identity());
    const binding = await coordinator.bindReceipt({
      ...revision7,
      receiptId: RECEIPT_A,
      pollEndpoint: pollEndpoint(RECEIPT_A),
    });
    if (binding.status !== "bound") {
      throw new Error("expected the revision 7 receipt fixture to bind");
    }
    expect(localStorage).toMatchObject({ writes: 2 });

    const resumed = await coordinator.reserve(
      identity({
        expectedLifecycleRevision: 8,
        endpoint: `/api/v2/billing/resources/${RESOURCE_ID}/cancel?resourceType=container`,
      }),
    );

    expect(resumed).toEqual(binding.intent);
    expect(resumed).toMatchObject({
      idempotencyKey: revision7.idempotencyKey,
      receiptId: RECEIPT_A,
      pollEndpoint: pollEndpoint(RECEIPT_A),
    });
    expect(generated()).toBe(1);
    expect(localStorage).toMatchObject({ writes: 2 });
  });

  it("preserves a bound revision 8 receipt when stale revision 7 authority arrives", async () => {
    const { coordinator, generated, localStorage } = harness();
    const revision8Identity = identity({
      expectedLifecycleRevision: 8,
      endpoint: `/api/v2/billing/resources/${RESOURCE_ID}/cancel?resourceType=container`,
    });
    const revision8 = await coordinator.reserve(revision8Identity);
    const revision8PollEndpoint = `/api/v2/billing/resources/${RESOURCE_ID}/cancel?receiptId=${RECEIPT_B}`;
    const binding = await coordinator.bindReceipt({
      ...revision8,
      receiptId: RECEIPT_B,
      pollEndpoint: revision8PollEndpoint,
    });
    if (binding.status !== "bound") {
      throw new Error("expected the revision 8 receipt fixture to bind");
    }
    expect(localStorage).toMatchObject({ writes: 2 });

    const resumed = await coordinator.reserve(identity());

    expect(resumed).toEqual(binding.intent);
    expect(resumed).toMatchObject({
      idempotencyKey: revision8.idempotencyKey,
      receiptId: RECEIPT_B,
      pollEndpoint: revision8PollEndpoint,
    });
    expect(generated()).toBe(1);
    expect(localStorage).toMatchObject({ writes: 2 });
  });

  it("never exposes a bound receipt when another user reserves the resource", async () => {
    const { coordinator, generated, localStorage } = harness();
    const firstUser = await coordinator.reserve(identity());
    await coordinator.bindReceipt({
      ...firstUser,
      receiptId: RECEIPT_A,
      pollEndpoint: pollEndpoint(RECEIPT_A),
    });

    const secondUser = await coordinator.reserve(
      identity({ initiatedByUserId: "user-b" }),
    );

    expect(secondUser).toMatchObject({
      initiatedByUserId: "user-b",
      receiptId: null,
      pollEndpoint: null,
    });
    expect(secondUser.idempotencyKey).not.toBe(firstUser.idempotencyKey);
    expect(generated()).toBe(2);
    expect(localStorage).toMatchObject({ writes: 3 });
  });

  it("fails closed when storage, Web Locks, or secure UUIDs are unavailable", async () => {
    await expectCoordinationCode(
      createBillingCancelIntentCoordinator({
        localStorage: null,
        lockManager: new SerialLockManager(),
        randomUUID: () => uuid(1),
      }).reserve(identity()),
      "BILLING_CANCEL_COORDINATION_STORAGE_UNAVAILABLE",
    );
    await expectCoordinationCode(
      createBillingCancelIntentCoordinator({
        localStorage: new MemoryStorage(),
        lockManager: null,
        randomUUID: () => uuid(1),
      }).reserve(identity()),
      "BILLING_CANCEL_COORDINATION_LOCK_UNAVAILABLE",
    );
    await expectCoordinationCode(
      createBillingCancelIntentCoordinator({
        localStorage: new MemoryStorage(),
        lockManager: new SerialLockManager(),
        randomUUID: null,
      }).reserve(identity()),
      "BILLING_CANCEL_COORDINATION_UUID_UNAVAILABLE",
    );
  });

  it("does not return a handle when localStorage rejects the durable write", async () => {
    const storage = new QuotaDeniedStorage();
    const coordinator = createBillingCancelIntentCoordinator({
      localStorage: storage,
      lockManager: new SerialLockManager(),
      randomUUID: () => uuid(1),
    });

    await expectCoordinationCode(
      coordinator.reserve(identity()),
      "BILLING_CANCEL_COORDINATION_STORAGE_ACCESS_FAILED",
    );
    expect(storage.size).toBe(0);
  });
});

describe("billing cancellation receipt compare-and-swap", () => {
  it("binds and resumes only the exact current intent", async () => {
    const { coordinator } = harness();
    const stale = await coordinator.reserve(identity());
    const currentIdentity = identity({ expectedLifecycleRevision: 8 });
    const current = await coordinator.reserve(currentIdentity);

    await expect(
      coordinator.bindReceipt({
        ...stale,
        receiptId: RECEIPT_A,
        pollEndpoint: pollEndpoint(RECEIPT_A),
      }),
    ).resolves.toEqual({ status: "superseded" });

    const binding = await coordinator.bindReceipt({
      ...current,
      receiptId: RECEIPT_A,
      pollEndpoint: pollEndpoint(RECEIPT_A),
    });
    expect(binding).toMatchObject({
      status: "bound",
      intent: {
        idempotencyKey: current.idempotencyKey,
        receiptId: RECEIPT_A,
        pollEndpoint: pollEndpoint(RECEIPT_A),
      },
    });
    await expect(coordinator.readExact(currentIdentity)).resolves.toEqual(
      binding.status === "bound" ? binding.intent : null,
    );

    await expect(
      coordinator.bindReceipt({
        ...current,
        receiptId: RECEIPT_A,
        pollEndpoint: pollEndpoint(RECEIPT_A),
      }),
    ).resolves.toEqual(binding);
    await expectCoordinationCode(
      coordinator.bindReceipt({
        ...current,
        receiptId: RECEIPT_B,
        pollEndpoint: pollEndpoint(RECEIPT_B),
      }),
      "BILLING_CANCEL_COORDINATION_RECEIPT_MISMATCH",
    );
  });

  it("reads a bound receipt for the same principal and resource across authority revisions", async () => {
    const { coordinator, lockManager } = harness();
    const oldIdentity = identity();
    const reserved = await coordinator.reserve(oldIdentity);
    const binding = await coordinator.bindReceipt({
      ...reserved,
      receiptId: RECEIPT_A,
      pollEndpoint: pollEndpoint(RECEIPT_A),
    });
    if (binding.status !== "bound") {
      throw new Error("expected the receipt fixture to bind");
    }

    await expect(
      coordinator.readBoundForResource(
        identity({
          expectedLifecycleRevision: 8,
          endpoint: `/api/v2/billing/resources/${RESOURCE_ID}/cancel?resourceType=container`,
        }),
      ),
    ).resolves.toEqual(binding.intent);
    expect(lockManager).toMatchObject({ acquisitions: 3 });
  });

  it("does not expose a bound receipt to another principal or resource", async () => {
    const { coordinator } = harness();
    const reserved = await coordinator.reserve(identity());
    await coordinator.bindReceipt({
      ...reserved,
      receiptId: RECEIPT_A,
      pollEndpoint: pollEndpoint(RECEIPT_A),
    });

    await expect(
      coordinator.readBoundForResource(
        identity({ initiatedByUserId: "user-b" }),
      ),
    ).resolves.toBeNull();
    await expect(
      coordinator.readBoundForResource(identity({ organizationId: "org-b" })),
    ).resolves.toBeNull();
    await expect(
      coordinator.readBoundForResource(
        identity({
          resourceId: "22222222-2222-4222-8222-222222222222",
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      coordinator.readBoundForResource(
        identity({ resourceType: "agent_sandbox" }),
      ),
    ).resolves.toBeNull();
  });

  it("does not return an unbound intent for resource recovery", async () => {
    const { coordinator } = harness();
    await coordinator.reserve(identity());

    await expect(
      coordinator.readBoundForResource(identity()),
    ).resolves.toBeNull();
  });

  it("clears a terminal receipt only when identity, key, and receipt match", async () => {
    const { coordinator } = harness();
    const reserved = await coordinator.reserve(identity());
    await coordinator.bindReceipt({
      ...reserved,
      receiptId: RECEIPT_A,
      pollEndpoint: pollEndpoint(RECEIPT_A),
    });

    await expect(
      coordinator.clearTerminal({ ...reserved, receiptId: RECEIPT_B }),
    ).resolves.toEqual({ status: "superseded" });
    await expect(
      coordinator.clearTerminal({
        ...reserved,
        idempotencyKey: uuid(99),
        receiptId: RECEIPT_A,
      }),
    ).resolves.toEqual({ status: "superseded" });
    await expect(
      coordinator.clearTerminal({ ...reserved, receiptId: RECEIPT_A }),
    ).resolves.toEqual({ status: "cleared" });
    await expect(coordinator.readExact(identity())).resolves.toBeNull();
  });

  it("keeps a newer unbound revision when an old tab clears a stale receipt", async () => {
    const { coordinator } = harness();
    const old = await coordinator.reserve(identity());
    const nextIdentity = identity({ expectedLifecycleRevision: 8 });
    const next = await coordinator.reserve(nextIdentity);

    await expect(
      coordinator.clearTerminal({ ...old, receiptId: RECEIPT_A }),
    ).resolves.toEqual({ status: "superseded" });
    await expect(coordinator.readExact(nextIdentity)).resolves.toEqual(next);
  });
});

describe("billing cancellation persisted schema", () => {
  it("quarantines corrupt data and reserves a fresh recoverable intent", async () => {
    const storage = new MemoryStorage();
    const key = billingCancelIntentStorageKey(identity());
    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        ...identity(),
        idempotencyKey: uuid(1),
        receiptId: null,
        pollEndpoint: null,
        unexpected: true,
      }),
    );
    const coordinator = createBillingCancelIntentCoordinator({
      localStorage: storage,
      lockManager: new SerialLockManager(),
      randomUUID: () => uuid(2),
    });

    await expect(coordinator.readExact(identity())).resolves.toBeNull();
    const recovered = await coordinator.reserve(identity());
    expect(recovered.idempotencyKey).toBe(uuid(2));
    const quarantine = storage
      .entries()
      .find(([storedKey]) => storedKey === `${key}:quarantine:v1`);
    expect(quarantine).toBeDefined();
    expect(JSON.parse(quarantine?.[1] ?? "{}")).toMatchObject({
      version: 1,
      reason: "BILLING_CANCEL_COORDINATION_STORAGE_CORRUPT",
    });
    expect(key.startsWith(BILLING_CANCEL_INTENT_STORAGE_PREFIX)).toBe(true);
  });

  it("quarantines a forward-version slot before creating current schema state", async () => {
    const storage = new MemoryStorage();
    const key = billingCancelIntentStorageKey(identity());
    storage.setItem(
      key,
      JSON.stringify({
        version: 2,
        ...identity(),
        idempotencyKey: uuid(1),
        receiptId: null,
        pollEndpoint: null,
      }),
    );
    const coordinator = createBillingCancelIntentCoordinator({
      localStorage: storage,
      lockManager: new SerialLockManager(),
      randomUUID: () => uuid(3),
    });

    await expect(coordinator.reserve(identity())).resolves.toMatchObject({
      idempotencyKey: uuid(3),
    });
    const quarantine = storage.getItem(`${key}:quarantine:v1`);
    expect(JSON.parse(quarantine ?? "{}")).toMatchObject({
      version: 1,
      reason: "BILLING_CANCEL_COORDINATION_STORAGE_FORWARD_VERSION",
    });
  });
});
