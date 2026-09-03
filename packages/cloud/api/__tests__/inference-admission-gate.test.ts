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
  warmInferenceRateLimitGate,
} from "@/lib/services/inference-admission-gate";
import * as admissionRecovery from "@/lib/services/inference-admission-recovery";
import { InferenceCredentialRevokedError } from "@/lib/services/inference-credential-revocation";
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
  rejectAsyncRateLimitStorage = false;

  readonly kv = {
    get: <T = unknown>(key: string): T | undefined => {
      const value = this.values.get(key);
      return value === undefined ? undefined : (structuredClone(value) as T);
    },
    put: <T>(key: string, value: T): void => {
      if (this.failNextPut) {
        this.failNextPut = false;
        throw new Error("injected storage failure");
      }
      this.values.set(key, structuredClone(value));
    },
    delete: (key: string): boolean => this.values.delete(key),
    list: <T = unknown>(options: { prefix?: string; limit?: number } = {}) =>
      this.syncEntries<T>(options),
  };

  private syncEntries<T>(options: {
    prefix?: string;
    limit?: number;
  }): Array<[string, T]> {
    const entries = [...this.values.entries()]
      .filter(
        ([key]) =>
          options.prefix === undefined || key.startsWith(options.prefix),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]): [string, T] => [key, structuredClone(value) as T]);
    return options.limit === undefined
      ? entries
      : entries.slice(0, options.limit);
  }

  async get<T>(key: string): Promise<T | undefined>;
  async get<T>(keys: string[]): Promise<Map<string, T>>;
  async get<T>(
    keyOrKeys: string | string[],
  ): Promise<T | undefined | Map<string, T>> {
    await Promise.resolve();
    if (
      this.rejectAsyncRateLimitStorage &&
      (keyOrKeys === "rate-limits" ||
        (Array.isArray(keyOrKeys) && keyOrKeys.includes("rate-limits")))
    ) {
      throw new Error("async rate-limit storage path must not be used");
    }
    if (Array.isArray(keyOrKeys)) {
      return new Map(
        keyOrKeys.flatMap((key) => {
          const value = this.values.get(key);
          return value === undefined
            ? []
            : [[key, structuredClone(value) as T]];
        }),
      );
    }
    const value = this.values.get(keyOrKeys);
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
    if (this.rejectAsyncRateLimitStorage && key === "rate-limits") {
      throw new Error("async rate-limit storage path must not be used");
    }
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

function createGate(
  storage = new TestStorage(),
  env: Record<string, unknown> = {},
): InferenceAdmissionGate {
  const state = {
    storage,
  } as unknown as DurableObjectState;
  return new InferenceAdmissionGate(state, env as never);
}

class QueueTestGate extends InferenceAdmissionGate {
  runBillingQueueOperation(operation: () => Promise<void>): Promise<void> {
    return this.serialize(operation);
  }

  runRevocationQueueOperation(operation: () => Promise<void>): Promise<void> {
    return this.serializeRevocation(operation);
  }
}

function createQueueTestGate(storage = new TestStorage()): QueueTestGate {
  const state = { storage } as unknown as DurableObjectState;
  return new QueueTestGate(state, {} as never);
}

function post(
  gate: InferenceAdmissionGate,
  path:
    | "/hydrate"
    | "/lease"
    | "/lease-authorized"
    | "/dispatch"
    | "/release"
    | "/settle"
    | "/rate-limit"
    | "/rate-limit-v2-cutover"
    | "/rate-limit-warm"
    | "/rate-limit-handoff"
    | "/credential/check"
    | "/credential/revoke"
    | "/subject/set-active"
    | "/session/revoke-through"
    | "/session/set-binding-active"
    | "/organization/set-active",
  body: Record<string, unknown>,
): Promise<Response> {
  const payload =
    (path === "/lease" || path === "/lease-authorized") &&
    body.recovery === undefined
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
      : path === "/lease" || path === "/lease-authorized"
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

function createRateLimitGateNetwork(organizationId = "org-a") {
  const legacyStorage = new TestStorage();
  const rateStorage = new TestStorage();
  const cutoverStorage = new TestStorage();
  const gates = new Map<string, InferenceAdmissionGate>();
  const requestedNames: string[] = [];
  const namespace = {
    getByName: (name: string) => {
      requestedNames.push(name);
      return {
        fetch: (request: RequestInfo | URL, init?: RequestInit) => {
          const gate = gates.get(name);
          if (!gate) throw new Error(`Unexpected gate identity: ${name}`);
          return gate.fetch(new Request(request, init));
        },
      };
    },
  };
  const env = { INFERENCE_ADMISSION_GATES: namespace };
  const legacyGate = createGate(legacyStorage, env);
  const rateGate = createGate(rateStorage, env);
  const cutoverGate = createGate(cutoverStorage, env);
  gates.set(organizationId, legacyGate);
  gates.set(`rate-limit:v2:${organizationId}`, rateGate);
  gates.set("rate-limit:v2:cutover", cutoverGate);
  return {
    bindings: { INFERENCE_ADMISSION_GATES: namespace },
    legacyGate,
    legacyStorage,
    rateGate,
    rateStorage,
    cutoverStorage,
    requestedNames,
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

  test("credential checks do not wait behind a blocked billing operation", async () => {
    const gate = createQueueTestGate();
    let enterBilling: () => void = () => undefined;
    const billingEntered = new Promise<void>((resolve) => {
      enterBilling = resolve;
    });
    let releaseBilling: () => void = () => undefined;
    const billingReleased = new Promise<void>((resolve) => {
      releaseBilling = resolve;
    });
    const blockedBilling = gate.runBillingQueueOperation(async () => {
      enterBilling();
      await billingReleased;
    });
    await billingEntered;

    const response = await Promise.race([
      post(gate, "/credential/check", {
        organizationId: "org-a",
        kind: "api_key",
        credentialId: "key-a",
        userId: "user-a",
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("credential check waited behind billing")),
          100,
        );
      }),
    ]);
    expect(response.status).toBe(200);

    releaseBilling();
    await blockedBilling;
  });

  test("revocation reads and writes retain one ordered queue", async () => {
    const gate = createQueueTestGate();
    const order: string[] = [];
    let enterFirst: () => void = () => undefined;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    let releaseFirst: () => void = () => undefined;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = gate.runRevocationQueueOperation(async () => {
      order.push("first:start");
      enterFirst();
      await firstReleased;
      order.push("first:end");
    });
    await firstEntered;
    const second = gate.runRevocationQueueOperation(async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
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

  test("rejects a cutover window whose next boundary exceeds safe integer precision", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    try {
      const gate = createGate(new TestStorage());
      expect(
        (
          await post(gate, "/rate-limit-v2-cutover", {
            windowMs: Number.MAX_SAFE_INTEGER,
          })
        ).status,
      ).toBe(400);
    } finally {
      clock.mockRestore();
    }
  });

  test("rate-limit client returns denials without balance hydration", async () => {
    const network = createRateLimitGateNetwork();
    await runWithCloudBindingsAsync(network.bindings, async () => {
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

  test("replays one rate-limit operation after a lost transport acknowledgement", async () => {
    const storage = new TestStorage();
    let gate = createGate(storage);
    let attempts = 0;
    const bindings = {
      INFERENCE_ADMISSION_GATES: {
        getByName: (_name: string) => ({
          fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
            attempts += 1;
            const response = await gate.fetch(new Request(request, init));
            if (attempts === 1) {
              gate = createGate(storage);
              throw new DOMException(
                "injected lost rate-limit acknowledgement",
                "TimeoutError",
              );
            }
            return response;
          },
        }),
      },
    };

    await runWithCloudBindingsAsync(bindings, async () => {
      await expect(
        consumeInferenceRateLimit({
          organizationId: "org-a",
          endpointType: "completions",
          windowMs: 60_000,
          maxRequests: 2,
        }),
      ).resolves.toMatchObject({ allowed: true, remaining: 1 });
    });
    expect(attempts).toBe(2);
    expect(
      storage.read<{ completions: { count: number } }>("rate-limits"),
    ).toMatchObject({ completions: { count: 1 } });
  });

  test("fails a late replay after more than 64 interleaved operations and eviction without recounting", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(61_000);
    const storage = new TestStorage();
    let gate = createGate(storage);
    const requests: Array<{ path: string; body: string }> = [];
    let attempts = 0;
    const bindings = {
      INFERENCE_ADMISSION_GATES: {
        getByName: (_name: string) => ({
          fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
            const incoming = new Request(request, init);
            requests.push({
              path: new URL(incoming.url).pathname,
              body: await incoming.clone().text(),
            });
            attempts += 1;
            const response = await gate.fetch(incoming);
            if (attempts === 1) {
              const body = JSON.parse(requests[0]!.body) as Record<
                string,
                unknown
              >;
              for (let index = 0; index < 63; index += 1) {
                expect(
                  (
                    await post(gate, "/rate-limit", {
                      ...body,
                      operationId: `interleaved-rate-operation-${index}`,
                    })
                  ).status,
                ).toBe(200);
              }
              clock.mockReturnValue(71_001);
              expect(
                (
                  await post(gate, "/rate-limit", {
                    ...body,
                    operationId: "interleaved-rate-operation-63",
                    operationDeadlineAt: 74_001,
                  })
                ).status,
              ).toBe(200);
              gate = createGate(storage);
              throw new DOMException(
                "injected lost rate-limit acknowledgement",
                "TimeoutError",
              );
            }
            return response;
          },
        }),
      },
    };

    try {
      await runWithCloudBindingsAsync(bindings, async () => {
        await expect(
          consumeInferenceRateLimit({
            organizationId: "org-a",
            endpointType: "completions",
            windowMs: 60_000,
            maxRequests: 1_000,
          }),
        ).rejects.toBeInstanceOf(InferenceAdmissionGateUnavailableError);
      });

      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      const persisted = storage.read<{
        completions: {
          count: number;
          receipts: Array<{ operationId: string }>;
        };
      }>("rate-limits");
      expect(persisted).toMatchObject({ completions: { count: 65 } });
      expect(persisted?.completions.receipts).toEqual([
        expect.objectContaining({
          operationId: "interleaved-rate-operation-63",
        }),
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  test("retries a cold rate-limit 503 but not a definitive denial", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);
    let attempts = 0;
    const bindings = {
      INFERENCE_ADMISSION_GATES: {
        getByName: (_name: string) => ({
          fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
            attempts += 1;
            if (attempts === 1) {
              return Response.json(
                { code: "inference_admission_gate_starting" },
                { status: 503 },
              );
            }
            return gate.fetch(new Request(request, init));
          },
        }),
      },
    };

    await runWithCloudBindingsAsync(bindings, async () => {
      await expect(
        consumeInferenceRateLimit({
          organizationId: "org-a",
          endpointType: "completions",
          windowMs: 60_000,
          maxRequests: 1,
        }),
      ).resolves.toMatchObject({ allowed: true, remaining: 0 });
    });
    expect(attempts).toBe(2);

    attempts = 0;
    await runWithCloudBindingsAsync(
      {
        INFERENCE_ADMISSION_GATES: {
          getByName: (_name: string) => ({
            fetch: async () => {
              attempts += 1;
              return Response.json(
                {
                  allowed: false,
                  remaining: 0,
                  resetAt: Date.now() + 60_000,
                  retryAfter: 60,
                },
                { status: 429 },
              );
            },
          }),
        },
      },
      async () => {
        await expect(
          consumeInferenceRateLimit({
            organizationId: "org-a",
            endpointType: "completions",
            windowMs: 60_000,
            maxRequests: 1,
          }),
        ).resolves.toMatchObject({ allowed: false, remaining: 0 });
      },
    );
    expect(attempts).toBe(1);
  });

  test("binds a rate-limit operation receipt to its policy and validity deadline", async () => {
    const gate = createGate();
    const windowStartedAt = Math.floor(Date.now() / 60_000) * 60_000;
    const operationDeadlineAt = Date.now() + 3_000;
    expect(
      (
        await post(gate, "/rate-limit", {
          operationId: "rate-operation-a",
          operationDeadlineAt,
          endpointType: "completions",
          windowMs: 60_000,
          maxRequests: 2,
          windowStartedAt,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/rate-limit", {
          operationId: "rate-operation-a",
          operationDeadlineAt,
          endpointType: "completions",
          windowMs: 60_000,
          maxRequests: 3,
          windowStartedAt,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(gate, "/rate-limit", {
          operationId: "rate-operation-a",
          operationDeadlineAt: operationDeadlineAt + 1,
          endpointType: "completions",
          windowMs: 60_000,
          maxRequests: 2,
          windowStartedAt,
        })
      ).status,
    ).toBe(409);
  });

  test("prunes replay receipts after the bounded internal retry window", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(61_000);
    const storage = new TestStorage();
    const gate = createGate(storage);
    const body = {
      endpointType: "completions",
      windowMs: 60_000,
      maxRequests: 10,
      windowStartedAt: 60_000,
    };
    try {
      expect(
        (
          await post(gate, "/rate-limit", {
            ...body,
            operationId: "expired-rate-operation",
            operationDeadlineAt: 64_000,
          })
        ).status,
      ).toBe(200);
      clock.mockReturnValue(71_001);
      expect(
        (
          await post(gate, "/rate-limit", {
            ...body,
            operationId: "current-rate-operation",
            operationDeadlineAt: 74_001,
          })
        ).status,
      ).toBe(200);
      expect(
        storage.read<{
          completions: { receipts: Array<{ operationId: string }> };
        }>("rate-limits")?.completions.receipts,
      ).toEqual([
        expect.objectContaining({ operationId: "current-rate-operation" }),
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  test("rate-only requests use synchronous SQLite KV and preserve the legacy key", async () => {
    const storage = new TestStorage();
    storage.rejectAsyncRateLimitStorage = true;
    const gate = createGate(storage);
    const windowStartedAt = 60_000;
    const clock = spyOn(Date, "now").mockReturnValue(windowStartedAt + 1);
    try {
      expect(
        (
          await post(gate, "/rate-limit", {
            endpointType: "completions",
            windowMs: 60_000,
            maxRequests: 1,
            windowStartedAt,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(gate, "/rate-limit", {
            endpointType: "completions",
            windowMs: 60_000,
            maxRequests: 1,
            windowStartedAt,
          })
        ).status,
      ).toBe(429);
      expect(storage.read<Record<string, unknown>>("rate-limits")).toEqual({
        completions: {
          count: 2,
          maxRequests: 1,
          windowMs: 60_000,
          windowStartedAt,
        },
      });
    } finally {
      clock.mockRestore();
    }
  });

  test("rate-limit prewarm loads its isolated window without consuming a request", async () => {
    const network = createRateLimitGateNetwork();
    await runWithCloudBindingsAsync(network.bindings, async () => {
      await warmInferenceRateLimitGate("org-a");
      await warmInferenceRateLimitGate("org-a");
      expect(network.legacyStorage.read("ledger")).toBeUndefined();
      expect(network.rateStorage.read("ledger")).toBeUndefined();
      expect(network.rateStorage.read("rate-limits")).toBeUndefined();
      expect(network.requestedNames).toContain("rate-limit:v2:org-a");
      expect(network.requestedNames).not.toContain("rate-limit:v2:cutover");
      expect(network.requestedNames).not.toContain("org-a");
      expect(
        network.requestedNames.filter((name) => name === "rate-limit:v2:org-a"),
      ).toHaveLength(1);
      expect(
        await consumeInferenceRateLimit({
          organizationId: "org-a",
          endpointType: "completions",
          windowMs: 60_000,
          maxRequests: 1,
        }),
      ).toMatchObject({ allowed: true, remaining: 0 });
    });
  });

  test("advances fixed windows entirely on the isolated rate-limit identity", async () => {
    const network = createRateLimitGateNetwork();
    const clock = spyOn(Date, "now").mockReturnValue(61_234);
    const body = {
      endpointType: "completions" as const,
      windowMs: 61_000,
      maxRequests: 1,
    };
    try {
      await runWithCloudBindingsAsync(network.bindings, async () => {
        expect(
          await consumeInferenceRateLimit({
            organizationId: "org-a",
            ...body,
          }),
        ).toMatchObject({ allowed: true, remaining: 0 });
        expect(
          await consumeInferenceRateLimit({
            organizationId: "org-a",
            ...body,
          }),
        ).toMatchObject({ allowed: false, remaining: 0 });

        clock.mockReturnValue(122_000);
        expect(
          await consumeInferenceRateLimit({
            organizationId: "org-a",
            ...body,
          }),
        ).toMatchObject({ allowed: true, remaining: 0 });
      });
      expect(network.legacyStorage.read("rate-limits")).toBeUndefined();
      expect(network.rateStorage.read("rate-limits")).toBeDefined();
      expect(network.requestedNames).not.toContain("rate-limit:v2:cutover");
      expect(network.requestedNames).not.toContain("org-a");
    } finally {
      clock.mockRestore();
    }
  });

  test("a queued legacy request cannot open a duplicate post-cutover window", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(61_234);
    const legacy = createGate();
    const isolated = createGate();
    const policy = {
      endpointType: "completions",
      windowMs: 61_000,
      maxRequests: 1,
    };
    try {
      expect(
        (
          await post(legacy, "/rate-limit", {
            ...policy,
            windowStartedAt: 61_000,
          })
        ).status,
      ).toBe(200);

      // This request selected the legacy lane before the boundary but did not
      // enter its rate-limit operation until after v2 had started accepting
      // the next window. It must remain charged to the old window.
      clock.mockReturnValue(122_001);
      expect(
        (
          await post(isolated, "/rate-limit", {
            ...policy,
            windowStartedAt: 122_000,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(legacy, "/rate-limit", {
            ...policy,
            windowStartedAt: 61_000,
          })
        ).status,
      ).toBe(429);
    } finally {
      clock.mockRestore();
    }
  });

  test("a stale queued request cannot roll durable rate-limit state backward", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(122_001);
    const storage = new TestStorage();
    const gate = createGate(storage);
    const policy = {
      endpointType: "completions",
      windowMs: 61_000,
      maxRequests: 1,
    };
    try {
      expect(
        (
          await post(gate, "/rate-limit", {
            ...policy,
            windowStartedAt: 122_000,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(gate, "/rate-limit", {
            ...policy,
            windowStartedAt: 61_000,
          })
        ).status,
      ).toBe(429);
      expect(
        (
          await post(gate, "/rate-limit", {
            ...policy,
            windowStartedAt: 122_000,
          })
        ).status,
      ).toBe(429);
      expect(
        storage.read<{ completions: { windowStartedAt: number } }>(
          "rate-limits",
        )?.completions.windowStartedAt,
      ).toBe(122_000);
    } finally {
      clock.mockRestore();
    }
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

  test("authorized leases reject revoked and disabled standing before reserving balance", async () => {
    const cases = [
      {
        mutationPath: "/credential/revoke" as const,
        mutation: {
          organizationId: "org-a",
          kind: "api_key",
          credentialId: "key-a",
        },
        reason: "credential_revoked",
      },
      {
        mutationPath: "/subject/set-active" as const,
        mutation: {
          organizationId: "org-a",
          userId: "user-a",
          active: false,
          reason: "account",
        },
        reason: "subject_account_disabled",
      },
      {
        mutationPath: "/organization/set-active" as const,
        mutation: { organizationId: "org-a", active: false },
        reason: "organization_disabled",
      },
    ];

    for (const [index, candidate] of cases.entries()) {
      const storage = new TestStorage();
      const gate = createGate(storage);
      await hydrateGate(gate, 5);
      expect(
        (await post(gate, candidate.mutationPath, candidate.mutation)).status,
      ).toBe(200);
      const response = await post(gate, "/lease-authorized", {
        requestId: `denied-${index}`,
        balanceUsd: 5,
        balanceRevision: "1",
        estimatedCostUsd: 1,
        credential: {
          organizationId: "org-a",
          kind: "api_key",
          credentialId: "key-a",
          userId: "user-a",
        },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        allowed: false,
        reason: candidate.reason,
      });
      expect(
        storage.read<{ activeLeaseCount: number }>("ledger"),
      ).toMatchObject({ activeLeaseCount: 0 });
    }
  });

  test("authorized leases preserve insufficient, duplicate, and concurrent accounting", async () => {
    const gate = createGate();
    await hydrateGate(gate, 2);
    const credential = {
      organizationId: "org-a",
      kind: "api_key",
      credentialId: "key-a",
      userId: "user-a",
    } as const;
    const first = await post(gate, "/lease-authorized", {
      requestId: "authorized-a",
      balanceUsd: 2,
      balanceRevision: "1",
      estimatedCostUsd: 1,
      credential,
    });
    expect(first.status).toBe(200);
    expect(
      (
        await post(gate, "/lease-authorized", {
          requestId: "authorized-a",
          balanceUsd: 2,
          balanceRevision: "1",
          estimatedCostUsd: 1,
          credential,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(gate, "/lease-authorized", {
          requestId: "authorized-insufficient",
          balanceUsd: 2,
          balanceRevision: "1",
          estimatedCostUsd: 2,
          credential,
        })
      ).status,
    ).toBe(402);

    const concurrentGate = createGate();
    await hydrateGate(concurrentGate, 1);
    const statuses = await Promise.all(
      ["concurrent-a", "concurrent-b"].map(
        async (requestId) =>
          (
            await post(concurrentGate, "/lease-authorized", {
              requestId,
              balanceUsd: 1,
              balanceRevision: "1",
              estimatedCostUsd: 1,
              credential,
            })
          ).status,
      ),
    );
    expect(statuses.sort()).toEqual([200, 402]);
  });

  test("authorized lease persistence failures publish neither admission nor balance hold", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);
    await hydrateGate(gate, 2);
    storage.failNextPut = true;
    await expect(
      post(gate, "/lease-authorized", {
        requestId: "authorized-storage-failure",
        balanceUsd: 2,
        balanceRevision: "1",
        estimatedCostUsd: 1,
        credential: {
          organizationId: "org-a",
          kind: "api_key",
          credentialId: "key-a",
          userId: "user-a",
        },
      }),
    ).rejects.toThrow("injected storage failure");
    expect(storage.read<{ activeLeaseCount: number }>("ledger")).toMatchObject({
      activeLeaseCount: 0,
    });
    expect(
      storage.read(storedLeaseKey("authorized-storage-failure")),
    ).toBeUndefined();
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

  test("replays the identical lease after a lost transport acknowledgement", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);
    await hydrateGate(gate, 5);
    const requests: Array<{ path: string; body: string }> = [];
    let attempts = 0;
    const bindings = {
      INFERENCE_ADMISSION_GATES: {
        getByName: (_name: string) => ({
          fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
            const incoming = new Request(request, init);
            requests.push({
              path: new URL(incoming.url).pathname,
              body: await incoming.clone().text(),
            });
            attempts += 1;
            const response = await gate.fetch(incoming);
            if (attempts === 1) {
              throw new DOMException(
                "injected lost lease acknowledgement",
                "TimeoutError",
              );
            }
            return response;
          },
        }),
      },
    };

    await runWithCloudBindingsAsync(bindings, async () => {
      const lease = await acquireInferenceAdmissionLease({
        organizationId: "org-a",
        requestId: "request-lost-lease-ack",
        balanceUsd: 5,
        balanceRevision: "1",
        estimatedCostUsd: 3,
        recovery: organizationRecovery("request-lost-lease-ack"),
      });
      expect(lease.requestId).toBe("request-lost-lease-ack");
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(storage.keyCount("lease:")).toBe(1);
    expect(storage.read<{ activeLeaseCount: number }>("ledger")).toMatchObject({
      activeLeaseCount: 1,
    });
  });

  test("replays the identical lease once after a 503", async () => {
    const storage = new TestStorage();
    const gate = createGate(storage);
    await hydrateGate(gate, 5);
    const requests: Array<{ path: string; body: string }> = [];
    const bindings = {
      INFERENCE_ADMISSION_GATES: {
        getByName: (_name: string) => ({
          fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
            const incoming = new Request(request, init);
            requests.push({
              path: new URL(incoming.url).pathname,
              body: await incoming.clone().text(),
            });
            if (requests.length === 1) {
              return Response.json(
                { code: "inference_admission_gate_starting" },
                { status: 503 },
              );
            }
            return gate.fetch(incoming);
          },
        }),
      },
    };

    await runWithCloudBindingsAsync(bindings, async () => {
      const lease = await acquireInferenceAdmissionLease({
        organizationId: "org-a",
        requestId: "request-starting-gate",
        balanceUsd: 5,
        balanceRevision: "1",
        estimatedCostUsd: 3,
        recovery: organizationRecovery("request-starting-gate"),
      });
      expect(lease.requestId).toBe("request-starting-gate");
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(storage.keyCount("lease:")).toBe(1);
    expect(storage.read<{ activeLeaseCount: number }>("ledger")).toMatchObject({
      activeLeaseCount: 1,
    });
  });

  test("does not retry definitive lease refusals", async () => {
    for (const status of [402, 403, 409, 429]) {
      let attempts = 0;
      const bindings = {
        INFERENCE_ADMISSION_GATES: {
          getByName: (_name: string) => ({
            fetch: async () => {
              attempts += 1;
              return Response.json(
                status === 402
                  ? { admitted: false, availableUsd: 1, requiredUsd: 2 }
                  : { code: "definitive_refusal" },
                { status },
              );
            },
          }),
        },
      };

      await runWithCloudBindingsAsync(bindings, async () => {
        await expect(
          acquireInferenceAdmissionLease({
            organizationId: "org-a",
            requestId: `request-refused-${status}`,
            balanceUsd: 5,
            balanceRevision: "1",
            estimatedCostUsd: 2,
            recovery: organizationRecovery(`request-refused-${status}`),
          }),
        ).rejects.toBeInstanceOf(Error);
      });
      expect(attempts).toBe(1);
    }
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

      expect(
        (
          await post(gate, "/credential/revoke", {
            organizationId: "org-a",
            kind: "api_key",
            credentialId: "key-a",
          })
        ).status,
      ).toBe(200);
      await expect(
        acquireInferenceAdmissionLease({
          organizationId: "org-a",
          requestId: "request-revoked",
          balanceUsd: 2,
          balanceRevision: "1",
          estimatedCostUsd: 1,
          recovery: organizationRecovery("request-revoked"),
          credential: {
            kind: "api_key",
            credentialId: "key-a",
            userId: "user-a",
          },
        }),
      ).rejects.toMatchObject({
        name: InferenceCredentialRevokedError.name,
        reason: "credential_revoked",
      });
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
