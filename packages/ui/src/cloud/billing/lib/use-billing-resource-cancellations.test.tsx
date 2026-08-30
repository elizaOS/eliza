/** Adversarial UI orchestration tests for cancellation replay and receipts. */

// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
const readReceiptMock = vi.hoisted(() => vi.fn());
vi.mock("../data/billing-resource-cancellation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../data/billing-resource-cancellation")
    >();
  return {
    ...actual,
    requestBillingCancellation: requestMock,
    readBillingCancellationReceipt: readReceiptMock,
  };
});

import { BillingCancellationHttpError } from "../data/billing-resource-cancellation";
import type { BillingSnapshotResource } from "../data/billing-snapshot";
import {
  type BillingCancelIntentLockManager,
  type BillingCancelIntentStorage,
  createBillingCancelIntentCoordinator,
} from "./billing-cancel-intent";
import { billingCancellationIdentityKey } from "./billing-resource-cancellation-view";
import { useBillingResourceCancellations } from "./use-billing-resource-cancellations";

const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";
const RECEIPT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const RECEIPT_ID_B = "44444444-4444-4444-8444-444444444444";
const JOB_ID_B = "55555555-5555-4555-8555-555555555555";
const RECEIPT_ENDPOINT = `/api/v1/billing/resources/${RESOURCE_ID}/cancel`;
const ENDPOINT = `${RECEIPT_ENDPOINT}?resourceType=container`;
const POLL_ENDPOINT = `${RECEIPT_ENDPOINT}?receiptId=${RECEIPT_ID}`;
const POLL_ENDPOINT_B = `${RECEIPT_ENDPOINT}?receiptId=${RECEIPT_ID_B}`;
const OBSERVED_AT = "2026-08-23T10:20:30.000Z";

class MemoryStorage implements BillingCancelIntentStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class SerialLockManager implements BillingCancelIntentLockManager {
  private tail: Promise<unknown> = Promise.resolve();
  request<T>(
    _name: string,
    options: { mode: "exclusive"; signal: AbortSignal },
    callback: () => T | PromiseLike<T>,
  ): Promise<T> {
    const result = this.tail.then(() => {
      if (options.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      return callback();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function resource(revision = 7): BillingSnapshotResource {
  const available = <T,>(value: T) => ({
    status: "available" as const,
    source: "test",
    observedAt: OBSERVED_AT,
    value,
  });
  return {
    resourceType: "container",
    resourceId: RESOURCE_ID,
    name: "Production API",
    status: "running",
    billingStatus: "active",
    billingInterval: "hour",
    lastBilledAt: null,
    nextBillingAt: null,
    estimatedNextBillingAt: null,
    cancellationControl: {
      displayAction: "stop",
      method: "POST",
      mode: "stop",
      endpoint: ENDPOINT,
      expectedLifecycleRevision: revision,
      eligible: true,
      blockers: [],
    },
    ratePerHour: available({
      value: "0.100000",
      unit: "usd_per_hour",
      currency: "USD",
    }),
    estimatedRecurringComputeCostPerDay: available({
      value: "2.400000",
      unit: "usd_per_day",
      currency: "USD",
    }),
  };
}

function receipt(
  status:
    | "accepted"
    | "provider_confirmed"
    | "conflict"
    | "terminal_attention" = "accepted",
) {
  const projection = {
    accepted: {
      computeStopped: false,
      providerStopped: false,
      infrastructureStatus: "queued",
    },
    provider_confirmed: {
      computeStopped: true,
      providerStopped: true,
      infrastructureStatus: "provider_confirmed",
    },
    conflict: {
      computeStopped: false,
      providerStopped: false,
      infrastructureStatus: "superseded",
    },
    terminal_attention: {
      computeStopped: false,
      providerStopped: false,
      infrastructureStatus: "terminal_attention",
    },
  }[status];
  return {
    receiptId: RECEIPT_ID,
    jobId: JOB_ID,
    resourceType: "container" as const,
    resourceId: RESOURCE_ID,
    action: "stop" as const,
    expectedLifecycleRevision: 7,
    status,
    ...projection,
    retainedBackupBilling: {
      status: "not_applicable" as const,
      ratePerHour: null,
    },
    acceptedAt: OBSERVED_AT,
    pollEndpoint: POLL_ENDPOINT,
  };
}

function newerReceipt() {
  return {
    ...receipt(),
    receiptId: RECEIPT_ID_B,
    jobId: JOB_ID_B,
    expectedLifecycleRevision: 8,
    pollEndpoint: POLL_ENDPOINT_B,
  };
}

function harness() {
  const storage = new MemoryStorage();
  const lockManager = new SerialLockManager();
  let uuid = 0;
  const dependencies = {
    localStorage: storage,
    lockManager,
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  };
  const coordinator = createBillingCancelIntentCoordinator(dependencies);
  return {
    coordinator,
    anotherCoordinator: () =>
      createBillingCancelIntentCoordinator(dependencies),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  requestMock.mockReset();
  readReceiptMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useBillingResourceCancellations", () => {
  it("retries a lost response with the same durable idempotency key", async () => {
    const { coordinator } = harness();
    const current = resource();
    requestMock
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce({
        disposition: "same_key_replay",
        receipt: receipt(),
      });
    const onTerminal = vi.fn();
    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal,
      }),
    );
    await waitFor(() => expect(result.current.states).toEqual({}));

    await act(async () => result.current.request(current));
    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({ kind: "ambiguous" });

    await act(async () => result.current.request(current));
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0]?.[0].idempotencyKey).toBe(
      requestMock.mock.calls[1]?.[0].idempotencyKey,
    );
    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({ kind: "accepted", receiptId: RECEIPT_ID });
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it("uses one server key when two mounted tabs submit concurrently", async () => {
    const { coordinator, anotherCoordinator } = harness();
    const secondCoordinator = anotherCoordinator();
    const current = resource();
    requestMock.mockRejectedValue(new TypeError("connection lost"));
    const first = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal: vi.fn(),
      }),
    );
    const second = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator: secondCoordinator,
        onTerminal: vi.fn(),
      }),
    );

    await act(async () => {
      await Promise.all([
        first.result.current.request(current),
        second.result.current.request(current),
      ]);
    });

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0]?.[0].idempotencyKey).toBe(
      requestMock.mock.calls[1]?.[0].idempotencyKey,
    );
    expect(
      first.result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({ kind: "ambiguous" });
    expect(
      second.result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({ kind: "ambiguous" });
  });

  it("resumes a bound receipt after reload and refreshes only on provider confirmation", async () => {
    const { coordinator } = harness();
    const current = resource();
    const identity = {
      organizationId: "org-a",
      initiatedByUserId: "user-a",
      resourceType: current.resourceType,
      resourceId: current.resourceId,
      expectedLifecycleRevision: 7,
      endpoint: ENDPOINT,
    } as const;
    const handle = await coordinator.reserve(identity);
    await coordinator.bindReceipt({
      ...handle,
      receiptId: RECEIPT_ID,
      pollEndpoint: POLL_ENDPOINT,
    });
    readReceiptMock.mockResolvedValue(receipt("provider_confirmed"));
    const onTerminal = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal,
      }),
    );

    await waitFor(() =>
      expect(
        result.current.states[billingCancellationIdentityKey(current)],
      ).toEqual({
        kind: "provider_confirmed",
        receiptId: RECEIPT_ID,
        computeStopped: true,
        providerStopped: true,
        retainedBackupBilling: { status: "not_applicable", ratePerHour: null },
      }),
    );
    expect(readReceiptMock).toHaveBeenCalledWith(
      POLL_ENDPOINT,
      expect.objectContaining({ receiptId: RECEIPT_ID }),
      expect.any(AbortSignal),
    );
    expect(onTerminal).toHaveBeenCalledTimes(1);
    await expect(coordinator.readExact(identity)).resolves.toBeNull();
  });

  it("recovers a bound old-revision receipt after reload without claiming the new lifecycle stopped", async () => {
    const { coordinator } = harness();
    const revisionSeven = resource(7);
    const revisionEight = resource(8);
    const oldIdentity = {
      organizationId: "org-a",
      initiatedByUserId: "user-a",
      resourceType: revisionSeven.resourceType,
      resourceId: revisionSeven.resourceId,
      expectedLifecycleRevision: 7,
      endpoint: ENDPOINT,
    } as const;
    const handle = await coordinator.reserve(oldIdentity);
    await coordinator.bindReceipt({
      ...handle,
      receiptId: RECEIPT_ID,
      pollEndpoint: POLL_ENDPOINT,
    });
    const oldReceipt = deferred<ReturnType<typeof receipt>>();
    readReceiptMock.mockReturnValue(oldReceipt.promise);
    const authoritativeRefresh = deferred<void>();
    const onTerminal = vi.fn(() => authoritativeRefresh.promise);

    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [revisionEight],
        coordinator,
        onTerminal,
      }),
    );

    await waitFor(() => expect(readReceiptMock).toHaveBeenCalledTimes(1));
    expect(readReceiptMock).toHaveBeenCalledWith(
      POLL_ENDPOINT,
      expect.objectContaining({
        expectedLifecycleRevision: 7,
        receiptId: RECEIPT_ID,
      }),
      expect.any(AbortSignal),
    );
    expect(
      result.current.states[billingCancellationIdentityKey(revisionEight)],
    ).toEqual({ kind: "accepted", receiptId: RECEIPT_ID });

    oldReceipt.resolve(receipt("provider_confirmed"));
    await waitFor(() =>
      expect(
        result.current.states[billingCancellationIdentityKey(revisionEight)],
      ).toEqual({ kind: "conflict", receiptId: RECEIPT_ID }),
    );
    expect(onTerminal).toHaveBeenCalledTimes(1);

    authoritativeRefresh.resolve();
    await waitFor(() =>
      expect(
        result.current.states[billingCancellationIdentityKey(revisionEight)],
      ).toBeUndefined(),
    );
  });

  it("keeps accepted billing visible while polling and exposes receipt failure", async () => {
    vi.useFakeTimers();
    const { coordinator } = harness();
    const current = resource();
    requestMock.mockResolvedValue({
      disposition: "accepted",
      receipt: receipt(),
    });
    readReceiptMock.mockRejectedValue(new TypeError("offline"));
    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal: vi.fn(),
        pollIntervalMs: 10,
      }),
    );

    await act(async () => result.current.request(current));
    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({ kind: "accepted", receiptId: RECEIPT_ID });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({ kind: "receipt_unavailable", receiptId: RECEIPT_ID });
  });

  it("honors Retry-After before polling a rate-limited receipt again", async () => {
    vi.useFakeTimers();
    const { coordinator } = harness();
    const current = resource();
    requestMock.mockResolvedValue({
      disposition: "accepted",
      receipt: receipt(),
    });
    readReceiptMock
      .mockRejectedValueOnce(
        new BillingCancellationHttpError(
          429,
          "rate_limited",
          "Try later",
          true,
          100,
        ),
      )
      .mockResolvedValueOnce(receipt());
    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal: vi.fn(),
        pollIntervalMs: 10,
      }),
    );

    await act(async () => result.current.request(current));
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(readReceiptMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(99));
    expect(readReceiptMock).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(readReceiptMock).toHaveBeenCalledTimes(2);
  });

  it("bounds a hung POST that ignores abort and exposes a safe same-key retry", async () => {
    const { coordinator } = harness();
    const current = resource();
    requestMock.mockImplementation(() => new Promise<never>(() => {}));
    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal: vi.fn(),
        networkTimeoutMs: 5,
      }),
    );

    await act(async () => result.current.request(current));

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(requestMock.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({ kind: "ambiguous" });

    const firstKey = requestMock.mock.calls[0]?.[0].idempotencyKey;
    requestMock.mockResolvedValue({
      disposition: "same_key_replay",
      receipt: receipt(),
    });
    await act(async () => result.current.request(current));
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[1]?.[0].idempotencyKey).toBe(firstKey);
    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({ kind: "accepted", receiptId: RECEIPT_ID });
  });

  it("bounds a hung receipt read that ignores abort and releases the in-flight poll", async () => {
    const { coordinator } = harness();
    const current = resource();
    const identity = {
      organizationId: "org-a",
      initiatedByUserId: "user-a",
      resourceType: current.resourceType,
      resourceId: current.resourceId,
      expectedLifecycleRevision: 7,
      endpoint: ENDPOINT,
    } as const;
    const handle = await coordinator.reserve(identity);
    await coordinator.bindReceipt({
      ...handle,
      receiptId: RECEIPT_ID,
      pollEndpoint: POLL_ENDPOINT,
    });
    readReceiptMock.mockImplementation(() => new Promise<never>(() => {}));
    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal: vi.fn(),
        pollIntervalMs: 1_000,
        networkTimeoutMs: 5,
      }),
    );

    await waitFor(() =>
      expect(
        result.current.states[billingCancellationIdentityKey(current)],
      ).toEqual({ kind: "receipt_unavailable", receiptId: RECEIPT_ID }),
    );
    expect(readReceiptMock).toHaveBeenCalledTimes(1);
    const signal = readReceiptMock.mock.calls[0]?.[2] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);

    await act(async () => result.current.checkReceipt(current));
    expect(readReceiptMock).toHaveBeenCalledTimes(2);
    expect(readReceiptMock.mock.calls[1]?.[2]).toBeInstanceOf(AbortSignal);
  });

  it("rotates the key after a server lifecycle revision change", async () => {
    const { coordinator } = harness();
    const first = resource(7);
    const second = resource(8);
    requestMock.mockRejectedValue(new TypeError("connection lost"));
    let resources = [first];
    const { result, rerender } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources,
        coordinator,
        onTerminal: vi.fn(),
      }),
    );

    await act(async () => result.current.request(first));
    resources = [second];
    rerender();
    await act(async () => result.current.request(second));

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0]?.[0].idempotencyKey).not.toBe(
      requestMock.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it("turns a server lifecycle conflict into refresh-and-review UI", async () => {
    const { coordinator } = harness();
    const current = resource();
    requestMock.mockRejectedValue(
      new BillingCancellationHttpError(
        409,
        "billing_state_conflict",
        "Lifecycle changed",
        false,
      ),
    );
    const onTerminal = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal,
      }),
    );

    await act(async () => result.current.request(current));

    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({ kind: "conflict" });
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it("keeps the strict accepted receipt when its local bind is superseded", async () => {
    const { coordinator, anotherCoordinator } = harness();
    const competingCoordinator = anotherCoordinator();
    const current = resource();
    const response = deferred<{
      disposition: "accepted";
      receipt: ReturnType<typeof receipt>;
    }>();
    requestMock.mockReturnValue(response.promise);
    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal: vi.fn(),
      }),
    );

    let requestOperation!: Promise<void>;
    act(() => {
      requestOperation = result.current.request(current);
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    const baseIdentity = {
      organizationId: "org-a",
      initiatedByUserId: "user-a",
      resourceType: current.resourceType,
      resourceId: current.resourceId,
      expectedLifecycleRevision: 7,
      endpoint: ENDPOINT,
    } as const;
    await competingCoordinator.reserve({
      ...baseIdentity,
      initiatedByUserId: "user-b",
      expectedLifecycleRevision: 8,
    });
    await competingCoordinator.reserve(baseIdentity);

    response.resolve({ disposition: "accepted", receipt: receipt() });
    await act(async () => requestOperation);

    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({ kind: "accepted", receiptId: RECEIPT_ID });
  });

  it("keeps a terminal POST receipt authoritative when its superseder bound the same receipt", async () => {
    const { coordinator, anotherCoordinator } = harness();
    const competingCoordinator = anotherCoordinator();
    const current = resource();
    const response = deferred<{
      disposition: "same_command";
      receipt: ReturnType<typeof receipt>;
    }>();
    requestMock.mockReturnValue(response.promise);
    const onTerminal = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal,
      }),
    );

    let requestOperation!: Promise<void>;
    act(() => {
      requestOperation = result.current.request(current);
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    const baseIdentity = {
      organizationId: "org-a",
      initiatedByUserId: "user-a",
      resourceType: current.resourceType,
      resourceId: current.resourceId,
      expectedLifecycleRevision: 7,
      endpoint: ENDPOINT,
    } as const;
    await competingCoordinator.reserve({
      ...baseIdentity,
      initiatedByUserId: "user-b",
      expectedLifecycleRevision: 8,
    });
    const replacement = await competingCoordinator.reserve(baseIdentity);
    await competingCoordinator.bindReceipt({
      ...replacement,
      receiptId: RECEIPT_ID,
      pollEndpoint: POLL_ENDPOINT,
    });

    response.resolve({
      disposition: "same_command",
      receipt: receipt("provider_confirmed"),
    });
    await act(async () => requestOperation);

    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({
      kind: "provider_confirmed",
      receiptId: RECEIPT_ID,
      computeStopped: true,
      providerStopped: true,
      retainedBackupBilling: { status: "not_applicable", ratePerHour: null },
    });
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it("prefers the newer bound receipt over a superseded old terminal response", async () => {
    const { coordinator, anotherCoordinator } = harness();
    const competingCoordinator = anotherCoordinator();
    const revisionSeven = resource(7);
    const revisionEight = resource(8);
    const response = deferred<{
      disposition: "same_command";
      receipt: ReturnType<typeof receipt>;
    }>();
    const newerPoll = deferred<ReturnType<typeof newerReceipt>>();
    requestMock.mockReturnValue(response.promise);
    readReceiptMock.mockReturnValue(newerPoll.promise);
    const onTerminal = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [revisionSeven],
        coordinator,
        onTerminal,
      }),
    );

    let requestOperation!: Promise<void>;
    act(() => {
      requestOperation = result.current.request(revisionSeven);
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    const newerHandle = await competingCoordinator.reserve({
      organizationId: "org-a",
      initiatedByUserId: "user-a",
      resourceType: revisionEight.resourceType,
      resourceId: revisionEight.resourceId,
      expectedLifecycleRevision: 8,
      endpoint: ENDPOINT,
    });
    await competingCoordinator.bindReceipt({
      ...newerHandle,
      receiptId: RECEIPT_ID_B,
      pollEndpoint: POLL_ENDPOINT_B,
    });

    response.resolve({
      disposition: "same_command",
      receipt: receipt("provider_confirmed"),
    });

    await waitFor(() => expect(readReceiptMock).toHaveBeenCalledTimes(1));
    expect(readReceiptMock).toHaveBeenCalledWith(
      POLL_ENDPOINT_B,
      expect.objectContaining({
        expectedLifecycleRevision: 8,
        receiptId: RECEIPT_ID_B,
      }),
      expect.any(AbortSignal),
    );
    expect(
      result.current.states[billingCancellationIdentityKey(revisionSeven)],
    ).toEqual({ kind: "accepted", receiptId: RECEIPT_ID_B });
    expect(onTerminal).not.toHaveBeenCalled();

    newerPoll.resolve(newerReceipt());
    await act(async () => requestOperation);
    expect(
      result.current.states[billingCancellationIdentityKey(revisionSeven)],
    ).toEqual({ kind: "accepted", receiptId: RECEIPT_ID_B });
  });

  it("refreshes instead of projecting an old terminal response over a newer unbound lifecycle", async () => {
    const { coordinator, anotherCoordinator } = harness();
    const competingCoordinator = anotherCoordinator();
    const revisionSeven = resource(7);
    const revisionEight = resource(8);
    const response = deferred<{
      disposition: "same_command";
      receipt: ReturnType<typeof receipt>;
    }>();
    const authoritativeRefresh = deferred<void>();
    requestMock.mockReturnValue(response.promise);
    const onTerminal = vi.fn(() => authoritativeRefresh.promise);
    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [revisionSeven],
        coordinator,
        onTerminal,
      }),
    );

    let requestOperation!: Promise<void>;
    act(() => {
      requestOperation = result.current.request(revisionSeven);
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    await competingCoordinator.reserve({
      organizationId: "org-a",
      initiatedByUserId: "user-a",
      resourceType: revisionEight.resourceType,
      resourceId: revisionEight.resourceId,
      expectedLifecycleRevision: 8,
      endpoint: ENDPOINT,
    });
    response.resolve({
      disposition: "same_command",
      receipt: receipt("provider_confirmed"),
    });

    await waitFor(() =>
      expect(
        result.current.states[billingCancellationIdentityKey(revisionSeven)],
      ).toEqual({ kind: "conflict", receiptId: RECEIPT_ID }),
    );
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(readReceiptMock).not.toHaveBeenCalled();

    authoritativeRefresh.resolve();
    await act(async () => requestOperation);
    expect(
      result.current.states[billingCancellationIdentityKey(revisionSeven)],
    ).toBeUndefined();
  });

  it("deduplicates concurrent receipt checks and never regresses a terminal receipt", async () => {
    const { coordinator } = harness();
    const current = resource();
    const identity = {
      organizationId: "org-a",
      initiatedByUserId: "user-a",
      resourceType: current.resourceType,
      resourceId: current.resourceId,
      expectedLifecycleRevision: 7,
      endpoint: ENDPOINT,
    } as const;
    const handle = await coordinator.reserve(identity);
    await coordinator.bindReceipt({
      ...handle,
      receiptId: RECEIPT_ID,
      pollEndpoint: POLL_ENDPOINT,
    });
    const pendingReceipt = deferred<ReturnType<typeof receipt>>();
    readReceiptMock.mockReturnValue(pendingReceipt.promise);
    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal: vi.fn().mockResolvedValue(undefined),
      }),
    );

    await waitFor(() => expect(readReceiptMock).toHaveBeenCalledTimes(1));
    let concurrentCheck!: Promise<void>;
    act(() => {
      concurrentCheck = result.current.checkReceipt(current);
    });
    expect(readReceiptMock).toHaveBeenCalledTimes(1);

    pendingReceipt.resolve(receipt("provider_confirmed"));
    await act(async () => concurrentCheck);
    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({
      kind: "provider_confirmed",
      receiptId: RECEIPT_ID,
      computeStopped: true,
      providerStopped: true,
      retainedBackupBilling: { status: "not_applicable", ratePerHour: null },
    });

    readReceiptMock.mockResolvedValue(receipt("accepted"));
    await act(async () => result.current.checkReceipt(current));
    expect(readReceiptMock).toHaveBeenCalledTimes(1);
    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({
      kind: "provider_confirmed",
      receiptId: RECEIPT_ID,
      computeStopped: true,
      providerStopped: true,
      retainedBackupBilling: { status: "not_applicable", ratePerHour: null },
    });
  });

  it.each([400, 401, 403, 404])(
    "does not automatically loop a non-retryable %s receipt failure",
    async (status) => {
      const { coordinator } = harness();
      const current = resource();
      const identity = {
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resourceType: current.resourceType,
        resourceId: current.resourceId,
        expectedLifecycleRevision: 7,
        endpoint: ENDPOINT,
      } as const;
      const handle = await coordinator.reserve(identity);
      await coordinator.bindReceipt({
        ...handle,
        receiptId: RECEIPT_ID,
        pollEndpoint: POLL_ENDPOINT,
      });
      readReceiptMock.mockRejectedValue(
        new BillingCancellationHttpError(
          status,
          "receipt_unavailable",
          "Receipt unavailable",
          false,
        ),
      );
      const { result } = renderHook(() =>
        useBillingResourceCancellations({
          organizationId: "org-a",
          initiatedByUserId: "user-a",
          resources: [current],
          coordinator,
          onTerminal: vi.fn(),
          pollIntervalMs: 5,
        }),
      );

      await waitFor(() =>
        expect(
          result.current.states[billingCancellationIdentityKey(current)],
        ).toEqual({ kind: "receipt_unavailable", receiptId: RECEIPT_ID }),
      );
      await act(
        () => new Promise((resolveDelay) => setTimeout(resolveDelay, 25)),
      );
      expect(readReceiptMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not automatically loop an invalid receipt contract", async () => {
    const { coordinator } = harness();
    const current = resource();
    const identity = {
      organizationId: "org-a",
      initiatedByUserId: "user-a",
      resourceType: current.resourceType,
      resourceId: current.resourceId,
      expectedLifecycleRevision: 7,
      endpoint: ENDPOINT,
    } as const;
    const handle = await coordinator.reserve(identity);
    await coordinator.bindReceipt({
      ...handle,
      receiptId: RECEIPT_ID,
      pollEndpoint: POLL_ENDPOINT,
    });
    readReceiptMock.mockRejectedValue(
      new Error("Billing cancellation response is invalid."),
    );
    const { result } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal: vi.fn(),
        pollIntervalMs: 5,
      }),
    );

    await waitFor(() =>
      expect(
        result.current.states[billingCancellationIdentityKey(current)],
      ).toEqual({ kind: "receipt_unavailable", receiptId: RECEIPT_ID }),
    );
    await act(
      () => new Promise((resolveDelay) => setTimeout(resolveDelay, 25)),
    );
    expect(readReceiptMock).toHaveBeenCalledTimes(1);
  });

  it("retries a rejected command after refresh with its preserved durable identity", async () => {
    const { coordinator } = harness();
    const current = resource();
    requestMock
      .mockRejectedValueOnce(
        new BillingCancellationHttpError(
          403,
          "forbidden",
          "Authority changed",
          false,
        ),
      )
      .mockResolvedValueOnce({
        disposition: "accepted",
        receipt: receipt(),
      });
    const onTerminal = vi.fn().mockResolvedValue(undefined);
    let resources = [current];
    const { result, rerender } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources,
        coordinator,
        onTerminal,
      }),
    );

    await act(async () => result.current.request(current));
    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({ kind: "rejected" });
    resources = [
      {
        ...current,
        cancellationControl: { ...current.cancellationControl },
      },
    ];
    rerender();

    await act(async () => result.current.request(resources[0]));
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0]?.[0].idempotencyKey).toBe(
      requestMock.mock.calls[1]?.[0].idempotencyKey,
    );
    expect(
      result.current.states[billingCancellationIdentityKey(current)],
    ).toEqual({ kind: "accepted", receiptId: RECEIPT_ID });
  });

  it("keeps an old-revision terminal receipt visible when refetch resolves with an error", async () => {
    const { coordinator } = harness();
    const revisionSeven = resource(7);
    const revisionEight = resource(8);
    const identity = {
      organizationId: "org-a",
      initiatedByUserId: "user-a",
      resourceType: revisionSeven.resourceType,
      resourceId: revisionSeven.resourceId,
      expectedLifecycleRevision: 7,
      endpoint: ENDPOINT,
    } as const;
    const handle = await coordinator.reserve(identity);
    await coordinator.bindReceipt({
      ...handle,
      receiptId: RECEIPT_ID,
      pollEndpoint: POLL_ENDPOINT,
    });
    const oldPoll = deferred<ReturnType<typeof receipt>>();
    const migratedPoll = deferred<ReturnType<typeof receipt>>();
    readReceiptMock
      .mockReturnValueOnce(oldPoll.promise)
      .mockReturnValueOnce(migratedPoll.promise);
    const authoritativeRefresh = deferred<{ isError: true; error: Error }>();
    const onTerminal = vi.fn(() => authoritativeRefresh.promise);
    let resources = [revisionSeven];
    const { result, rerender } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources,
        coordinator,
        onTerminal,
      }),
    );

    await waitFor(() => expect(readReceiptMock).toHaveBeenCalledTimes(1));
    expect(
      result.current.states[billingCancellationIdentityKey(revisionSeven)],
    ).toEqual({ kind: "accepted", receiptId: RECEIPT_ID });

    resources = [revisionEight];
    rerender();
    await waitFor(() => expect(readReceiptMock).toHaveBeenCalledTimes(2));
    expect(
      result.current.states[billingCancellationIdentityKey(revisionEight)],
    ).toEqual({ kind: "accepted", receiptId: RECEIPT_ID });

    migratedPoll.resolve(receipt("conflict"));
    await waitFor(() =>
      expect(
        result.current.states[billingCancellationIdentityKey(revisionEight)],
      ).toEqual({ kind: "conflict", receiptId: RECEIPT_ID }),
    );
    expect(onTerminal).toHaveBeenCalledTimes(1);

    authoritativeRefresh.resolve({
      isError: true,
      error: new Error("snapshot refetch failed"),
    });
    await act(async () => authoritativeRefresh.promise);
    expect(
      result.current.states[billingCancellationIdentityKey(revisionEight)],
    ).toEqual({ kind: "conflict", receiptId: RECEIPT_ID });

    oldPoll.resolve(receipt("accepted"));
    await act(async () => Promise.resolve());
    expect(readReceiptMock).toHaveBeenCalledTimes(2);
    expect(
      result.current.states[billingCancellationIdentityKey(revisionEight)],
    ).toEqual({ kind: "conflict", receiptId: RECEIPT_ID });
  });

  it("reconciles a delayed POST that binds after the lifecycle revision changes", async () => {
    const { coordinator } = harness();
    const revisionSeven = resource(7);
    const revisionEight = resource(8);
    const response = deferred<{
      disposition: "accepted";
      receipt: ReturnType<typeof receipt>;
    }>();
    const migratedPoll = deferred<ReturnType<typeof receipt>>();
    requestMock.mockReturnValue(response.promise);
    readReceiptMock.mockReturnValue(migratedPoll.promise);
    let resources = [revisionSeven];
    const { result, rerender } = renderHook(() =>
      useBillingResourceCancellations({
        organizationId: "org-a",
        initiatedByUserId: "user-a",
        resources,
        coordinator,
        onTerminal: vi.fn(),
      }),
    );

    let requestOperation!: Promise<void>;
    act(() => {
      requestOperation = result.current.request(revisionSeven);
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));

    resources = [revisionEight];
    rerender();
    response.resolve({ disposition: "accepted", receipt: receipt() });
    await act(async () => requestOperation);

    await waitFor(() => expect(readReceiptMock).toHaveBeenCalledTimes(1));
    expect(readReceiptMock).toHaveBeenCalledWith(
      POLL_ENDPOINT,
      expect.objectContaining({
        expectedLifecycleRevision: 7,
        receiptId: RECEIPT_ID,
      }),
      expect.any(AbortSignal),
    );
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(
      result.current.states[billingCancellationIdentityKey(revisionEight)],
    ).toEqual({ kind: "accepted", receiptId: RECEIPT_ID });

    const recovered = await coordinator.readBoundForResource({
      organizationId: "org-a",
      initiatedByUserId: "user-a",
      resourceType: revisionEight.resourceType,
      resourceId: revisionEight.resourceId,
      expectedLifecycleRevision: 8,
      endpoint: ENDPOINT,
    });
    expect(recovered).toMatchObject({
      expectedLifecycleRevision: 7,
      receiptId: RECEIPT_ID,
    });
  });

  it("hides old-principal state during render and ignores its late completion", async () => {
    const { coordinator } = harness();
    const current = resource();
    const response = deferred<{
      disposition: "accepted";
      receipt: ReturnType<typeof receipt>;
    }>();
    requestMock.mockReturnValue(response.promise);
    let organizationId = "org-a";
    const renderSnapshots: Array<{
      organizationId: string;
      states: Readonly<
        Record<
          string,
          ReturnType<typeof useBillingResourceCancellations>["states"][string]
        >
      >;
    }> = [];
    const { result, rerender } = renderHook(() => {
      const controller = useBillingResourceCancellations({
        organizationId,
        initiatedByUserId: "user-a",
        resources: [current],
        coordinator,
        onTerminal: vi.fn(),
      });
      renderSnapshots.push({ organizationId, states: controller.states });
      return controller;
    });

    let requestOperation!: Promise<void>;
    act(() => {
      requestOperation = result.current.request(current);
    });
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    organizationId = "org-b";
    rerender();

    const firstNewPrincipalRender = renderSnapshots.find(
      (snapshot) => snapshot.organizationId === "org-b",
    );
    expect(firstNewPrincipalRender?.states).toEqual({});
    response.resolve({ disposition: "accepted", receipt: receipt() });
    await act(async () => requestOperation);
    expect(result.current.states).toEqual({});
  });
});
