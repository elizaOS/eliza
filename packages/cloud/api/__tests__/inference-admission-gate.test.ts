/**
 * Exercises Worker inference admission against an in-memory Durable Object
 * state, including exact endpoint windows, balance leases, and fail-closed
 * clients.
 */

import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import { creditsService } from "@/lib/services/credits";
import {
  acquireInferenceAdmissionLease,
  consumeInferenceRateLimit,
  InferenceAdmissionGateUnavailableError,
  InferenceAdmissionLeaseRejectedError,
  markInferenceAdmissionLeaseDispatched,
  settleInferenceAdmissionLease,
} from "@/lib/services/inference-admission-gate";
import * as admissionRecovery from "@/lib/services/inference-admission-recovery";
import { InferenceAdmissionGate } from "../src/inference-admission-gate";

const recoverExpiredLease = spyOn(
  admissionRecovery,
  "recoverExpiredInferenceAdmissionLease",
);
const getOrganizationBalanceSnapshot = spyOn(
  creditsService,
  "getOrganizationBalanceSnapshot",
);

class TestStorage {
  private readonly values = new Map<string, unknown>();
  alarm: number | undefined;
  failNextPut = false;
  failNextSetAlarm = false;
  failNextTransactionCommit = false;

  async get<T>(key: string): Promise<T | undefined> {
    await Promise.resolve();
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async list<T>(options: {
    prefix?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    await Promise.resolve();
    const entries = [...this.values.entries()]
      .filter(
        ([key]) =>
          options.prefix === undefined || key.startsWith(options.prefix),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.limit);
    return new Map(
      entries.map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }

  async put(key: string, value: unknown): Promise<void> {
    await Promise.resolve();
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("injected storage failure");
    }
    this.values.set(key, structuredClone(value));
  }

  read<T>(key: string): T | undefined {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  remove(key: string): void {
    this.values.delete(key);
  }

  keyCount(prefix: string): number {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix))
      .length;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    if (this.failNextSetAlarm) {
      this.failNextSetAlarm = false;
      throw new Error("injected setAlarm failure");
    }
    this.alarm = scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = undefined;
  }

  clearAlarm(): void {
    this.alarm = undefined;
  }

  async transaction<T>(
    closure: (transaction: {
      put(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<boolean>;
      setAlarm(scheduledTime: number): Promise<void>;
      deleteAlarm(): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const stagedValues = new Map<string, unknown>();
    const deletedKeys = new Set<string>();
    let stagedAlarm = this.alarm;
    const result = await closure({
      put: async (key, value) => {
        await Promise.resolve();
        if (this.failNextPut) {
          this.failNextPut = false;
          throw new Error("injected storage failure");
        }
        stagedValues.set(key, structuredClone(value));
        deletedKeys.delete(key);
      },
      delete: async (key) => {
        await Promise.resolve();
        const existed =
          stagedValues.delete(key) ||
          (!deletedKeys.has(key) && this.values.has(key));
        deletedKeys.add(key);
        return existed;
      },
      setAlarm: async (scheduledTime) => {
        await Promise.resolve();
        if (this.failNextSetAlarm) {
          this.failNextSetAlarm = false;
          throw new Error("injected setAlarm failure");
        }
        stagedAlarm = scheduledTime;
      },
      deleteAlarm: async () => {
        await Promise.resolve();
        stagedAlarm = undefined;
      },
    });
    if (this.failNextTransactionCommit) {
      this.failNextTransactionCommit = false;
      throw new Error("injected transaction commit failure");
    }
    for (const key of deletedKeys) {
      this.values.delete(key);
    }
    for (const [key, value] of stagedValues) {
      this.values.set(key, value);
    }
    this.alarm = stagedAlarm;
    return result;
  }
}

function storedLeaseKey(requestId: string): string {
  return `lease:${encodeURIComponent(requestId)}`;
}

function createGate(storage = new TestStorage()): InferenceAdmissionGate {
  const state = {
    storage,
  } as unknown as DurableObjectState;
  return new InferenceAdmissionGate(state, {} as never);
}

function post(
  gate: InferenceAdmissionGate,
  path:
    | "/hydrate"
    | "/lease"
    | "/dispatch"
    | "/release"
    | "/settle"
    | "/rate-limit",
  body: Record<string, unknown>,
): Promise<Response> {
  const payload =
    path === "/lease" && body.recovery === undefined
      ? {
          ...body,
          organizationId: body.organizationId ?? "org-a",
          recovery: {
            version: 1,
            kind: "organization",
            organizationId: "org-a",
            requestId: body.requestId,
            userId: "user-a",
            model: "openai/gpt-oss-120b",
            provider: "openai",
            billingSource: "gateway",
            description: "test inference",
            accounting: { kind: "direct_debit" },
          },
        }
      : path === "/lease"
        ? { ...body, organizationId: body.organizationId ?? "org-a" }
        : body;
  return gate.fetch(
    new Request(`https://gate.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

async function hydrateGate(
  gate: InferenceAdmissionGate,
  balanceUsd: number,
  balanceRevision = "1",
): Promise<void> {
  expect(
    (
      await post(gate, "/hydrate", {
        balanceUsd,
        balanceRevision,
      })
    ).status,
  ).toBe(200);
}

function gateBindings(gate: InferenceAdmissionGate) {
  return {
    INFERENCE_ADMISSION_GATES: {
      getByName: (_name: string) => ({
        fetch: (request: RequestInfo | URL, init?: RequestInit) =>
          gate.fetch(new Request(request, init)),
      }),
    },
  };
}

function organizationRecovery(requestId: string) {
  return {
    version: 1 as const,
    kind: "organization" as const,
    organizationId: "org-a",
    requestId,
    userId: "user-a",
    model: "openai/gpt-oss-120b",
    provider: "openai",
    billingSource: "gateway",
    description: "test inference",
    accounting: { kind: "direct_debit" as const },
  };
}

describe("InferenceAdmissionGate", () => {
  beforeEach(() => {
    recoverExpiredLease.mockReset();
    recoverExpiredLease.mockRejectedValue(
      new Error("recovery intentionally unavailable"),
    );
    getOrganizationBalanceSnapshot.mockReset();
    getOrganizationBalanceSnapshot.mockResolvedValue({
      balanceUsd: 0,
      revision: "2",
    });
  });
  afterAll(() => {
    recoverExpiredLease.mockRestore();
    getOrganizationBalanceSnapshot.mockRestore();
  });

  test("serializes and persists an exact fixed endpoint window", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(61_234);
    try {
      const storage = new TestStorage();
      const gate = createGate(storage);
      const body = {
        endpointType: "completions",
        windowMs: 60_000,
        maxRequests: 3,
      };
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => post(gate, "/rate-limit", body)),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 200, 200, 429, 429,
      ]);
      const denied = (await responses[4]?.json()) as {
        allowed: boolean;
        remaining: number;
        resetAt: number;
        retryAfter: number;
      };
      expect(denied).toEqual({
        allowed: false,
        remaining: 0,
        resetAt: 120_000,
        retryAfter: 59,
      });

      const evicted = createGate(storage);
      expect((await post(evicted, "/rate-limit", body)).status).toBe(429);
      clock.mockReturnValue(120_000);
      expect((await post(evicted, "/rate-limit", body)).status).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });

  test("rate-limit client returns denials without balance hydration", async () => {
    const gate = createGate();
    await runWithCloudBindingsAsync(gateBindings(gate), async () => {
      expect(
        await consumeInferenceRateLimit({
          organizationId: "org-a",
          endpointType: "embeddings",
          windowMs: 60_000,
          maxRequests: 1,
        }),
      ).toMatchObject({ allowed: true, remaining: 0 });
      expect(
        await consumeInferenceRateLimit({
          organizationId: "org-a",
          endpointType: "embeddings",
          windowMs: 60_000,
          maxRequests: 1,
        }),
      ).toMatchObject({ allowed: false, remaining: 0 });
    });
    await expect(
      consumeInferenceRateLimit({
        organizationId: "org-a",
        endpointType: "embeddings",
        windowMs: 60_000,
        maxRequests: 1,
      }),
    ).rejects.toBeInstanceOf(InferenceAdmissionGateUnavailableError);
  });

  test("policy changes preserve the current endpoint count", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(61_234);
    try {
      const gate = createGate();
      const request = (maxRequests: number) =>
        post(gate, "/rate-limit", {
          endpointType: "strict",
          windowMs: 60_000,
          maxRequests,
        });

      expect((await request(3)).status).toBe(200);
      expect((await request(3)).status).toBe(200);
      expect((await request(1)).status).toBe(429);
      const raised = await request(4);
      expect(raised.status).toBe(200);
      expect(await raised.json()).toMatchObject({
        allowed: true,
        remaining: 0,
      });
      expect((await request(4)).status).toBe(429);
    } finally {
      clock.mockRestore();
    }
  });

  test("does not publish an unpersisted endpoint count", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);
    const body = {
      endpointType: "standard",
      windowMs: 60_000,
      maxRequests: 2,
    };
    storage.failNextPut = true;

    await expect(post(gate, "/rate-limit", body)).rejects.toThrow(
      "injected storage failure",
    );
    expect(storage.read("rate-limits")).toBeUndefined();
    expect(await (await post(gate, "/rate-limit", body)).json()).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  test("serializes concurrent leases so cached balance cannot be overspent", async () => {
    const gate = createGate();
    await hydrateGate(gate, 5);
    const responses = await Promise.all([
      post(gate, "/lease", {
        requestId: "request-a",
        balanceUsd: 5,
        balanceAt: Date.now(),
        balanceRevision: "1",
        estimatedCostUsd: 3,
      }),
      post(gate, "/lease", {
        requestId: "request-b",
        balanceUsd: 5,
        balanceAt: Date.now(),
        balanceRevision: "1",
        estimatedCostUsd: 3,
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 402,
    ]);
  });

  test("bounds each alarm batch and drains every lease at maximum capacity", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const storage = new TestStorage();
      const gate = createGate(storage);
      await hydrateGate(gate, 3);

      const statuses: number[] = [];
      for (let index = 0; index < 2_048; index++) {
        statuses.push(
          (
            await post(gate, "/lease", {
              requestId: `capacity-${index}`,
              balanceUsd: 3,
              balanceRevision: "1",
              estimatedCostUsd: 0.001,
            })
          ).status,
        );
      }
      expect(statuses.every((status) => status === 200)).toBe(true);
      expect(
        (
          await post(gate, "/lease", {
            requestId: "capacity-overflow",
            balanceUsd: 3,
            balanceRevision: "1",
            estimatedCostUsd: 0.001,
          })
        ).status,
      ).toBe(503);

      const saturatedLedger = storage.read<{
        activeLeaseCount: number;
        settledRequestIds: string[];
      }>("ledger");
      expect(saturatedLedger?.activeLeaseCount).toBe(2_048);
      expect(
        new TextEncoder().encode(JSON.stringify(saturatedLedger)).byteLength,
      ).toBeLessThan(512 * 1_024);
      expect(storage.keyCount("lease:")).toBe(2_048);
      expect(storage.keyCount("lease-active:")).toBe(2_048);
      expect(storage.keyCount("lease-expiry:")).toBe(2_048);

      clock.mockReturnValue(1_300_000);
      let alarmRuns = 0;
      while (storage.alarm !== undefined && alarmRuns < 65) {
        storage.clearAlarm();
        await gate.alarm();
        alarmRuns++;
      }

      expect(alarmRuns).toBe(64);
      expect(storage.alarm).toBeUndefined();
      expect(storage.keyCount("lease:")).toBe(0);
      expect(storage.keyCount("lease-active:")).toBe(0);
      expect(storage.keyCount("lease-expiry:")).toBe(0);
      expect(
        storage.read<{
          activeLeaseCount: number;
          availableUsd: number;
          settledRequestIds: string[];
        }>("ledger"),
      ).toMatchObject({
        activeLeaseCount: 0,
        availableUsd: 3,
        settledRequestIds: expect.arrayContaining([
          "capacity-0",
          "capacity-2047",
        ]),
      });
      expect(recoverExpiredLease).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  test("settles collected cost and never restores capacity from a stale high hint", async () => {
    const gate = createGate();
    await hydrateGate(gate, 5);
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-a",
          balanceUsd: 5,
          balanceAt: Date.now(),
          balanceRevision: "1",
          estimatedCostUsd: 3,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/dispatch", {
          requestId: "request-a",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/settle", {
          requestId: "request-a",
          balanceBackedUsd: 2,
          gateConsumedUsd: 2,
          balanceUsd: 3,
          balanceRevision: "2",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-b",
          balanceUsd: 50,
          balanceAt: Date.now(),
          balanceRevision: "1",
          estimatedCostUsd: 3,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-c",
          balanceUsd: 50,
          balanceAt: Date.now(),
          balanceRevision: "1",
          estimatedCostUsd: 1,
        })
      ).status,
    ).toBe(402);
  });

  test("repeat hydration cannot double-count an active authoritative hold", async () => {
    const gate = createGate();
    await hydrateGate(gate, 100, "1");
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-a",
          balanceUsd: 100,
          balanceAt: Date.now(),
          balanceRevision: "1",
          estimatedCostUsd: 10,
        })
      ).status,
    ).toBe(200);
    await hydrateGate(gate, 90, "2");
    expect(
      (
        await post(gate, "/dispatch", {
          requestId: "request-a",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/settle", {
          requestId: "request-a",
          balanceBackedUsd: 10,
          gateConsumedUsd: 10,
          balanceUsd: 90,
          balanceRevision: "2",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-b",
          balanceUsd: 90,
          balanceAt: Date.now(),
          balanceRevision: "2",
          estimatedCostUsd: 90,
        })
      ).status,
    ).toBe(200);
  });

  test("treats an identical lease retry as idempotent", async () => {
    const gate = createGate();
    await hydrateGate(gate, 5);
    const recovery = {
      ...organizationRecovery("request-a"),
      metadata: { z: 1, nested: { z: true, a: false } },
    };
    const body = {
      requestId: "request-a",
      balanceUsd: 5,
      balanceAt: Date.now(),
      balanceRevision: "1",
      estimatedCostUsd: 3,
      recovery,
    };

    expect((await post(gate, "/lease", body)).status).toBe(200);
    expect(
      (
        await post(gate, "/lease", {
          ...body,
          recovery: {
            ...recovery,
            metadata: { nested: { a: false, z: true }, z: 1 },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/lease", {
          ...body,
          estimatedCostUsd: 4,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(gate, "/lease", {
          ...body,
          recovery: { ...recovery, provider: "different-provider" },
        })
      ).status,
    ).toBe(409);
  });

  test("client maps rejection and missing bindings to typed failures", async () => {
    const gate = createGate();
    await hydrateGate(gate, 2);
    await runWithCloudBindingsAsync(gateBindings(gate), async () => {
      const lease = await acquireInferenceAdmissionLease({
        organizationId: "org-a",
        requestId: "request-a",
        balanceUsd: 2,
        balanceRevision: "1",
        estimatedCostUsd: 2,
        recovery: organizationRecovery("request-a"),
      });
      await expect(
        acquireInferenceAdmissionLease({
          organizationId: "org-a",
          requestId: "request-b",
          balanceUsd: 2,
          balanceRevision: "1",
          estimatedCostUsd: 1,
          recovery: organizationRecovery("request-b"),
        }),
      ).rejects.toBeInstanceOf(InferenceAdmissionLeaseRejectedError);
      await markInferenceAdmissionLeaseDispatched(lease);
      await settleInferenceAdmissionLease(lease, 2);
    });

    await expect(
      acquireInferenceAdmissionLease({
        organizationId: "org-a",
        requestId: "request-c",
        balanceUsd: 2,
        balanceRevision: "1",
        estimatedCostUsd: 1,
        recovery: organizationRecovery("request-c"),
      }),
    ).rejects.toBeInstanceOf(InferenceAdmissionGateUnavailableError);
  });

  test("does not publish an unpersisted lease after a storage failure", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);
    await hydrateGate(gate, 5);
    storage.failNextPut = true;
    const body = {
      requestId: "request-a",
      balanceUsd: 5,
      balanceAt: Date.now(),
      balanceRevision: "1",
      estimatedCostUsd: 3,
    };

    await expect(post(gate, "/lease", body)).rejects.toThrow(
      "injected storage failure",
    );
    expect(storage.read<{ activeLeaseCount: number }>("ledger")).toMatchObject({
      activeLeaseCount: 0,
    });
    expect(storage.read(storedLeaseKey("request-a"))).toBeUndefined();
    expect((await post(gate, "/lease", body)).status).toBe(200);
    expect(storage.read<{ activeLeaseCount: number }>("ledger")).toMatchObject({
      activeLeaseCount: 1,
    });
    expect(storage.read(storedLeaseKey("request-a"))).toBeDefined();
  });

  test("commits dispatch state and its recovery alarm atomically", async () => {
    for (const fault of ["setAlarm", "commit"] as const) {
      const storage = new TestStorage();
      const gate = createGate(storage);
      await hydrateGate(gate, 5);
      expect(
        (
          await post(gate, "/lease", {
            requestId: `request-${fault}`,
            balanceUsd: 5,
            balanceRevision: "1",
            estimatedCostUsd: 3,
          })
        ).status,
      ).toBe(200);
      const priorAlarm = storage.alarm;
      if (fault === "setAlarm") {
        storage.failNextSetAlarm = true;
      } else {
        storage.failNextTransactionCommit = true;
      }

      await expect(
        post(gate, "/dispatch", {
          requestId: `request-${fault}`,
          preProviderCancellationToken: `cancel-${fault}`,
        }),
      ).rejects.toThrow(
        fault === "setAlarm"
          ? "injected setAlarm failure"
          : "injected transaction commit failure",
      );
      const persistedLease = storage.read<{
        phase: string;
        preProviderCancellationToken?: string;
      }>(storedLeaseKey(`request-${fault}`));
      expect(persistedLease?.phase).toBe("leased");
      expect(
        persistedLease
          ? "preProviderCancellationToken" in persistedLease
          : true,
      ).toBe(false);
      expect(storage.alarm).toBe(priorAlarm);

      const evicted = createGate(storage);
      expect(
        (
          await post(evicted, "/dispatch", {
            requestId: `request-${fault}`,
            preProviderCancellationToken: `cancel-${fault}`,
          })
        ).status,
      ).toBe(200);
      expect(storage.alarm).toBeNumber();
    }
  });

  test("fails closed when a summarized lease body disappears", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);
    await hydrateGate(gate, 5);
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-missing-body",
          balanceUsd: 5,
          balanceRevision: "1",
          estimatedCostUsd: 1,
        })
      ).status,
    ).toBe(200);
    storage.remove(storedLeaseKey("request-missing-body"));

    await expect(
      post(createGate(storage), "/dispatch", {
        requestId: "request-missing-body",
      }),
    ).rejects.toThrow("lease presence index is corrupt");
  });

  test("duplicate dispatch refreshes and durably heals a missing recovery alarm", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const storage = new TestStorage();
      const gate = createGate(storage);
      await hydrateGate(gate, 5);
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-a",
            balanceUsd: 5,
            balanceRevision: "1",
            estimatedCostUsd: 3,
          })
        ).status,
      ).toBe(200);
      const dispatchBody = {
        requestId: "request-a",
        preProviderCancellationToken: "cancel-request-a",
      };
      expect((await post(gate, "/dispatch", dispatchBody)).status).toBe(200);
      const firstExpiry = storage.read<{ expiresAt: number }>(
        storedLeaseKey("request-a"),
      )?.expiresAt;
      storage.clearAlarm();

      clock.mockReturnValue(2_000);
      const duplicate = await post(gate, "/dispatch", dispatchBody);
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({
        dispatched: true,
        duplicate: true,
      });
      const healedExpiry = storage.read<{ expiresAt: number }>(
        storedLeaseKey("request-a"),
      )?.expiresAt;
      expect(healedExpiry).toBeGreaterThan(firstExpiry ?? 0);
      expect(storage.alarm).toBeGreaterThanOrEqual(firstExpiry ?? 0);
      expect(storage.alarm).toBeLessThanOrEqual(healedExpiry ?? 0);
    } finally {
      clock.mockRestore();
    }
  });

  test("lost dispatch acknowledgements cancel zero provider work while the Worker is alive", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);
    await hydrateGate(gate, 10);
    let dispatchAttempts = 0;
    let providerInvocations = 0;
    const bindings = {
      INFERENCE_ADMISSION_GATES: {
        getByName: (_name: string) => ({
          fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
            const incoming = new Request(request, init);
            const response = await gate.fetch(incoming);
            if (new URL(incoming.url).pathname === "/dispatch") {
              dispatchAttempts++;
              throw new Error("injected lost dispatch response");
            }
            return response;
          },
        }),
      },
    };

    await runWithCloudBindingsAsync(bindings, async () => {
      const lease = await acquireInferenceAdmissionLease({
        organizationId: "org-a",
        requestId: "request-lost-ack",
        balanceUsd: 10,
        balanceRevision: "1",
        estimatedCostUsd: 4,
        recovery: organizationRecovery("request-lost-ack"),
      });
      let dispatchError: unknown;
      try {
        await markInferenceAdmissionLeaseDispatched(lease);
        providerInvocations++;
      } catch (error) {
        dispatchError = error;
        await settleInferenceAdmissionLease(lease, 0, 0);
      }

      expect(dispatchError).toBeInstanceOf(
        InferenceAdmissionGateUnavailableError,
      );
      expect(lease.providerDispatched).toBe(false);
      expect(providerInvocations).toBe(0);
    });

    expect(dispatchAttempts).toBe(3);
    expect(getOrganizationBalanceSnapshot).not.toHaveBeenCalled();
    expect(storage.alarm).toBeUndefined();
    expect(
      storage.read<{
        availableUsd: number;
        activeLeaseCount: number;
        settledRequestIds: string[];
      }>("ledger"),
    ).toMatchObject({
      availableUsd: 10,
      activeLeaseCount: 0,
      settledRequestIds: ["request-lost-ack"],
    });
    expect(storage.read(storedLeaseKey("request-lost-ack"))).toBeUndefined();
    await gate.alarm();
    expect(recoverExpiredLease).not.toHaveBeenCalled();
  });

  test("a dispatched lease cannot use the pre-provider release path without its capability", async () => {
    const gate = createGate();
    await hydrateGate(gate, 5);
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-a",
          balanceUsd: 5,
          balanceRevision: "1",
          estimatedCostUsd: 3,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/dispatch", {
          requestId: "request-a",
          preProviderCancellationToken: "cancel-request-a",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/release", {
          requestId: "request-a",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(gate, "/release", {
          requestId: "request-a",
          preProviderCancellationToken: "different-capability",
        })
      ).status,
    ).toBe(409);
  });

  test("persists a lower rejected hint across Durable Object eviction", async () => {
    const storage = new TestStorage();
    const first = createGate(storage);
    await hydrateGate(first, 5);
    expect(
      (
        await post(first, "/lease", {
          requestId: "request-a",
          balanceUsd: 5,
          balanceAt: Date.now(),
          balanceRevision: "1",
          estimatedCostUsd: 3,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(first, "/lease", {
          requestId: "request-b",
          balanceUsd: 1,
          balanceAt: Date.now(),
          balanceRevision: "2",
          estimatedCostUsd: 1,
        })
      ).status,
    ).toBe(402);

    const evicted = createGate(storage);
    expect(
      (
        await post(evicted, "/release", {
          requestId: "request-a",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(evicted, "/lease", {
          requestId: "request-c",
          balanceUsd: 5,
          balanceAt: Date.now(),
          balanceRevision: "1",
          estimatedCostUsd: 2,
        })
      ).status,
    ).toBe(402);
  });

  test("never restores spent capacity from a stale revision after idle time", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const storage = new TestStorage();
      const gate = createGate(storage);
      await hydrateGate(gate, 10);
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-a",
            balanceUsd: 10,
            balanceAt: 1_000,
            balanceRevision: "1",
            estimatedCostUsd: 6,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(gate, "/dispatch", {
            requestId: "request-a",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(gate, "/settle", {
            requestId: "request-a",
            balanceBackedUsd: 6,
            gateConsumedUsd: 6,
            balanceUsd: 4,
            balanceRevision: "2",
          })
        ).status,
      ).toBe(200);

      clock.mockReturnValue(1_000_000);
      await gate.alarm();
      const evicted = createGate(storage);
      expect(
        (
          await post(evicted, "/lease", {
            requestId: "request-b",
            balanceUsd: 10,
            balanceAt: 900_000,
            balanceRevision: "1",
            estimatedCostUsd: 6,
          })
        ).status,
      ).toBe(402);
    } finally {
      clock.mockRestore();
    }
  });

  test("releases an expired lease that no provider dispatched", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const gate = createGate();
      await hydrateGate(gate, 10);
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-a",
            balanceUsd: 10,
            balanceAt: 1_000,
            balanceRevision: "1",
            estimatedCostUsd: 2,
          })
        ).status,
      ).toBe(200);
      clock.mockReturnValue(1_300_000);
      await gate.alarm();
      expect(recoverExpiredLease).not.toHaveBeenCalled();
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-b",
            balanceUsd: 10,
            balanceAt: 1_299_000,
            balanceRevision: "1",
            estimatedCostUsd: 10,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(gate, "/dispatch", {
            requestId: "request-a",
          })
        ).status,
      ).toBe(409);
    } finally {
      clock.mockRestore();
    }
  });

  test("a spurious early alarm always re-arms an active lease", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const storage = new TestStorage();
      const gate = createGate(storage);
      await hydrateGate(gate, 10);
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-a",
            balanceUsd: 10,
            balanceRevision: "1",
            estimatedCostUsd: 2,
          })
        ).status,
      ).toBe(200);
      const expiresAt = storage.read<{ expiresAt: number }>(
        storedLeaseKey("request-a"),
      )?.expiresAt;
      expect(expiresAt).toBeNumber();

      clock.mockReturnValue(2_000);
      storage.clearAlarm();
      await gate.alarm();
      expect(storage.alarm).toBe(expiresAt);
      expect(storage.read(storedLeaseKey("request-a"))).toBeDefined();

      clock.mockReturnValue(expiresAt ?? 1_300_000);
      storage.clearAlarm();
      await gate.alarm();
      expect(storage.alarm).toBeUndefined();
      expect(recoverExpiredLease).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  test("an unrelated newer balance revision cannot release an expired lease", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const gate = createGate();
      await hydrateGate(gate, 10, "1");
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-a",
            balanceUsd: 10,
            balanceRevision: "1",
            estimatedCostUsd: 8,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(gate, "/dispatch", {
            requestId: "request-a",
          })
        ).status,
      ).toBe(200);

      clock.mockReturnValue(1_300_000);
      await expect(gate.alarm()).rejects.toThrow(
        "Inference admission lease recovery failed",
      );
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-b",
            balanceUsd: 10,
            balanceRevision: "1",
            estimatedCostUsd: 3,
          })
        ).status,
      ).toBe(402);
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-c",
            balanceUsd: 10,
            balanceRevision: "2",
            estimatedCostUsd: 10,
          })
        ).status,
      ).toBe(402);
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-d",
            balanceUsd: 100,
            balanceRevision: "1",
            estimatedCostUsd: 3,
          })
        ).status,
      ).toBe(402);
    } finally {
      clock.mockRestore();
    }
  });

  test("request-specific durable recovery releases an expired lease", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const gate = createGate();
      await hydrateGate(gate, 10, "1");
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-a",
            balanceUsd: 10,
            balanceRevision: "1",
            estimatedCostUsd: 8,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(gate, "/dispatch", {
            requestId: "request-a",
          })
        ).status,
      ).toBe(200);
      recoverExpiredLease.mockResolvedValue({
        balanceUsd: 2,
        balanceRevision: "2",
        collectedUsd: 8,
        gateConsumedUsd: 8,
      });

      clock.mockReturnValue(1_300_000);
      await gate.alarm();
      expect(recoverExpiredLease).toHaveBeenCalledTimes(1);
      expect(recoverExpiredLease.mock.calls[0]?.[1]).toBe(8);

      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-b",
            balanceUsd: 2,
            balanceRevision: "2",
            estimatedCostUsd: 2,
          })
        ).status,
      ).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });

  test("normal settlements advance revisions so delayed snapshots cannot resurrect spend", async () => {
    const gate = createGate();
    await hydrateGate(gate, 10, "0");
    for (const requestId of ["request-a", "request-b"]) {
      expect(
        (
          await post(gate, "/lease", {
            requestId,
            balanceUsd: 10,
            balanceRevision: "0",
            estimatedCostUsd: 1,
          })
        ).status,
      ).toBe(200);
      expect((await post(gate, "/dispatch", { requestId })).status).toBe(200);
    }

    expect(
      (
        await post(gate, "/settle", {
          requestId: "request-a",
          balanceBackedUsd: 1,
          gateConsumedUsd: 1,
          balanceUsd: 9,
          balanceRevision: "1",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/settle", {
          requestId: "request-b",
          balanceBackedUsd: 1,
          gateConsumedUsd: 1,
          balanceUsd: 8,
          balanceRevision: "2",
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-c",
          balanceUsd: 9,
          balanceRevision: "1",
          estimatedCostUsd: 9,
        })
      ).status,
    ).toBe(402);
    expect(
      (
        await post(gate, "/lease", {
          requestId: "request-d",
          balanceUsd: 8,
          balanceRevision: "2",
          estimatedCostUsd: 8,
        })
      ).status,
    ).toBe(200);
  });

  test("out-of-order recovery snapshots release already-backed holds exactly once", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const storage = new TestStorage();
      const gate = createGate(storage);
      await hydrateGate(gate, 10, "0");
      for (const requestId of ["request-a", "request-b"]) {
        expect(
          (
            await post(gate, "/lease", {
              requestId,
              balanceUsd: 10,
              balanceRevision: "0",
              estimatedCostUsd: 1,
            })
          ).status,
        ).toBe(200);
        expect((await post(gate, "/dispatch", { requestId })).status).toBe(200);
      }

      let releaseOlderRecovery: (() => void) | undefined;
      recoverExpiredLease.mockImplementation(async (context) => {
        if (context.requestId === "request-a") {
          await new Promise<void>((resolve) => {
            releaseOlderRecovery = resolve;
          });
          return {
            balanceUsd: 9,
            balanceRevision: "1",
            collectedUsd: 1,
            gateConsumedUsd: 1,
          };
        }
        return {
          balanceUsd: 8,
          balanceRevision: "2",
          collectedUsd: 1,
          gateConsumedUsd: 1,
        };
      });

      clock.mockReturnValue(1_300_000);
      const recovery = gate.alarm();
      for (let index = 0; index < 100; index += 1) {
        if (
          storage.read<{ balanceRevision: string }>("ledger")
            ?.balanceRevision === "2"
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(
        storage.read<{ balanceRevision: string }>("ledger")?.balanceRevision,
      ).toBe("2");
      releaseOlderRecovery?.();
      await recovery;

      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-c",
            balanceUsd: 8,
            balanceRevision: "2",
            estimatedCostUsd: 8,
          })
        ).status,
      ).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });

  test("an alarm recovery claim wins over a racing late settlement", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const gate = createGate();
      await hydrateGate(gate, 10, "0");
      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-a",
            balanceUsd: 10,
            balanceRevision: "0",
            estimatedCostUsd: 2,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(gate, "/dispatch", {
            requestId: "request-a",
          })
        ).status,
      ).toBe(200);

      let finishRecovery: (() => void) | undefined;
      recoverExpiredLease.mockImplementation(async () => {
        await new Promise<void>((resolve) => {
          finishRecovery = resolve;
        });
        return {
          balanceUsd: 8,
          balanceRevision: "1",
          collectedUsd: 2,
          gateConsumedUsd: 2,
        };
      });
      clock.mockReturnValue(1_300_000);
      const recovery = gate.alarm();
      while (!finishRecovery) await Promise.resolve();

      expect(
        (
          await post(gate, "/settle", {
            requestId: "request-a",
            balanceBackedUsd: 0,
            gateConsumedUsd: 0,
            balanceUsd: 10,
            balanceRevision: "0",
          })
        ).status,
      ).toBe(409);
      finishRecovery();
      await recovery;

      expect(
        (
          await post(gate, "/lease", {
            requestId: "request-b",
            balanceUsd: 8,
            balanceRevision: "1",
            estimatedCostUsd: 8,
          })
        ).status,
      ).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });

  test("refuses to initialize a new gate from any lease hint", async () => {
    expect(
      (
        await post(createGate(), "/lease", {
          requestId: "request-a",
          balanceUsd: 10,
          balanceRevision: "1",
          estimatedCostUsd: 1,
        })
      ).status,
    ).toBe(503);
  });

  test("rejects a lease without typed recovery context", async () => {
    const gate = createGate();
    await hydrateGate(gate, 10);
    const response = await gate.fetch(
      new Request("https://gate.test/lease", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "request-a",
          balanceUsd: 10,
          balanceRevision: "1",
          estimatedCostUsd: 1,
        }),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("rejects unsupported recovery context versions", async () => {
    const gate = createGate();
    await hydrateGate(gate, 10);

    for (const version of [undefined, 2]) {
      const requestId = `unsupported-recovery-version-${String(version)}`;
      const response = await post(gate, "/lease", {
        requestId,
        balanceUsd: 10,
        balanceRevision: "1",
        estimatedCostUsd: 1,
        recovery: {
          ...organizationRecovery(requestId),
          version,
        },
      });
      expect(response.status).toBe(400);
    }
  });

  test("stores bounded recovery context per lease and rejects oversized context", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);
    await hydrateGate(gate, 10);
    const acceptedRequestId = "bounded-recovery-context";
    const accepted = await post(gate, "/lease", {
      requestId: acceptedRequestId,
      balanceUsd: 10,
      balanceRevision: "1",
      estimatedCostUsd: 1,
      recovery: {
        ...organizationRecovery(acceptedRequestId),
        metadata: { opaque: "x".repeat(30_000) },
      },
    });
    expect(accepted.status).toBe(200);
    expect(
      new TextEncoder().encode(
        JSON.stringify(storage.read(storedLeaseKey(acceptedRequestId))),
      ).byteLength,
    ).toBeLessThan(64 * 1_024);

    const oversizedRequestId = "oversized-recovery-context";
    expect(
      (
        await post(gate, "/lease", {
          requestId: oversizedRequestId,
          balanceUsd: 10,
          balanceRevision: "1",
          estimatedCostUsd: 1,
          recovery: {
            ...organizationRecovery(oversizedRequestId),
            metadata: { opaque: "x".repeat(33_000) },
          },
        })
      ).status,
    ).toBe(400);
  });

  test("rejects malformed organization accounting lane contracts", async () => {
    const gate = createGate();
    await hydrateGate(gate, 10);
    const affiliateUserId = "00000000-0000-4000-8000-000000000002";
    const validAttribution = {
      affiliateCodeId: "00000000-0000-4000-8000-000000000003",
      affiliateUserId,
      affiliateCode: "partner",
      markupPercent: 0.2,
    };
    const malformedAccounting: Array<{ name: string; value: unknown }> = [
      { name: "missing lane", value: undefined },
      { name: "unknown lane", value: { kind: "db_ledger" } },
      {
        name: "direct lane with extra fields",
        value: { kind: "direct_debit", unexpected: true },
      },
      {
        name: "malformed attribution",
        value: {
          kind: "affiliate_debit",
          attribution: {
            ...validAttribution,
            affiliateCodeId: "not-a-uuid",
          },
          payoutSourceId: "ai_billing:affiliate:request",
        },
      },
      {
        name: "payout source with edge whitespace",
        value: {
          kind: "affiliate_debit",
          attribution: validAttribution,
          payoutSourceId: " payout-with-edge-whitespace",
        },
      },
    ];

    for (const [index, malformed] of malformedAccounting.entries()) {
      const requestId = `malformed-accounting-${index}`;
      const response = await post(gate, "/lease", {
        requestId,
        balanceUsd: 10,
        balanceRevision: "1",
        estimatedCostUsd: 1,
        recovery: {
          ...organizationRecovery(requestId),
          accounting: malformed.value,
        },
      });
      expect({ case: malformed.name, status: response.status }).toEqual({
        case: malformed.name,
        status: 400,
      });
    }

    const selfReferralRequestId = "malformed-accounting-self-referral";
    const selfReferral = await post(gate, "/lease", {
      requestId: selfReferralRequestId,
      balanceUsd: 10,
      balanceRevision: "1",
      estimatedCostUsd: 1,
      recovery: {
        ...organizationRecovery(selfReferralRequestId),
        userId: affiliateUserId,
        accounting: {
          kind: "affiliate_debit",
          attribution: validAttribution,
          payoutSourceId: "ai_billing:affiliate:self-referral",
        },
      },
    });
    expect(selfReferral.status).toBe(400);
  });

  test("rejects malformed pinned app recovery policy", async () => {
    const gate = createGate();
    await hydrateGate(gate, 10);
    const validPolicy = {
      name: "Pinned app",
      creatorUserId: "00000000-0000-4000-8000-000000000004",
      monetizationEnabled: true,
      reviewStatus: "approved",
      platformOffsetAmount: 1,
      purchaseSharePercentage: 30,
      inferenceMarkupPercentage: 20,
    };
    const malformedPolicies: Array<{ name: string; value: unknown }> = [
      {
        name: "missing creator identity",
        value: { ...validPolicy, creatorUserId: "" },
      },
      {
        name: "non-boolean monetization flag",
        value: { ...validPolicy, monetizationEnabled: "true" },
      },
      {
        name: "negative platform offset",
        value: { ...validPolicy, platformOffsetAmount: -1 },
      },
      {
        name: "missing purchase share",
        value: { ...validPolicy, purchaseSharePercentage: undefined },
      },
      {
        name: "unknown review state",
        value: { ...validPolicy, reviewStatus: "not-a-review-state" },
      },
      {
        name: "numeric string markup",
        value: { ...validPolicy, inferenceMarkupPercentage: "20" },
      },
    ];

    for (const [index, malformed] of malformedPolicies.entries()) {
      const requestId = `malformed-app-policy-${index}`;
      const response = await post(gate, "/lease", {
        requestId,
        balanceUsd: 10,
        balanceRevision: "1",
        estimatedCostUsd: 1,
        recovery: {
          version: 1,
          kind: "app",
          organizationId: "org-a",
          requestId,
          userId: "user-a",
          model: "openai/gpt-oss-120b",
          provider: "openai",
          billingSource: "gateway",
          description: "test app inference",
          appId: "app-a",
          estimatedBaseCostUsd: 0.5,
          appPolicy: malformed.value,
        },
      });
      expect({ case: malformed.name, status: response.status }).toEqual({
        case: malformed.name,
        status: 400,
      });
    }
  });
});
