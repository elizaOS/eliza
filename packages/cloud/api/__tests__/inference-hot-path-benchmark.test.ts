/**
 * Benchmarks the real in-process Durable Object rate, lease, and dispatch path while
 * proving every measured request completes before any settlement work starts.
 */

import { expect, test } from "bun:test";
import { InferenceAdmissionGate } from "../src/inference-admission-gate";

process.env.INFERENCE_AUTH_CACHE_ENABLED = "true";

class BenchmarkStorage {
  private readonly values = new Map<string, unknown>();
  readonly kv = {
    get: <T>(key: string): T | undefined =>
      this.values.get(key) as T | undefined,
    put: (key: string, value: unknown): void => {
      this.values.set(key, structuredClone(value));
    },
    delete: (key: string): boolean => this.values.delete(key),
  };

  async get<T>(key: string): Promise<T | undefined> {
    await Promise.resolve();
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    await Promise.resolve();
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    await Promise.resolve();
    return this.values.delete(key);
  }

  async setAlarm(_scheduledTime: number): Promise<void> {
    await Promise.resolve();
  }

  async deleteAlarm(): Promise<void> {
    await Promise.resolve();
  }

  async transaction<T>(
    closure: (transaction: {
      put(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<boolean>;
      setAlarm(scheduledTime: number): Promise<void>;
      deleteAlarm(): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    return await closure({
      put: (key, value) => this.put(key, value),
      delete: (key) => this.delete(key),
      setAlarm: (scheduledTime) => this.setAlarm(scheduledTime),
      deleteAlarm: () => this.deleteAlarm(),
    });
  }
}

function createGate(): InferenceAdmissionGate {
  return new InferenceAdmissionGate(
    { storage: new BenchmarkStorage() } as unknown as DurableObjectState,
    {} as never,
  );
}

function post(
  gate: InferenceAdmissionGate,
  path: "/hydrate" | "/rate-limit" | "/lease" | "/dispatch" | "/settle",
  body: Record<string, unknown>,
): Promise<Response> {
  return gate.fetch(
    new Request(`https://inference-admission.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function percentile(samples: number[], fraction: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * fraction) - 1),
  );
  const value = ordered[index];
  if (value === undefined) throw new Error("benchmark produced no samples");
  return value;
}

test("warm exact rate plus monetary lease remains a bounded cache-local operation", async () => {
  const gate = createGate();
  const iterations = 250;
  const estimatedCostUsd = 0.001;
  const hydration = await post(gate, "/hydrate", {
    balanceUsd: 100,
    balanceRevision: "1",
  });
  expect(hydration.status).toBe(200);

  const durationsMs: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const requestId = `benchmark-${index}`;
    const startedAt = performance.now();
    const rate = await post(gate, "/rate-limit", {
      endpointType: "completions",
      windowMs: 60_000,
      maxRequests: iterations + 1,
    });
    const lease = await post(gate, "/lease", {
      organizationId: "org-benchmark",
      requestId,
      balanceUsd: 100,
      balanceRevision: "1",
      estimatedCostUsd,
      recovery: {
        version: 1,
        kind: "organization",
        organizationId: "org-benchmark",
        requestId,
        userId: "user-benchmark",
        model: "openai/gpt-oss-120b",
        provider: "openai",
        billingSource: "gateway",
        description: "inference hot-path benchmark",
        accounting: { kind: "direct_debit" },
      },
    });
    const dispatch = await post(gate, "/dispatch", { requestId });
    durationsMs.push(performance.now() - startedAt);

    expect(rate.status).toBe(200);
    expect(lease.status).toBe(200);
    expect(dispatch.status).toBe(200);

    // Settlement represents post-provider work and is deliberately excluded
    // from the measured request segment.
    const settlement = await post(gate, "/settle", {
      requestId,
      balanceBackedUsd: estimatedCostUsd,
      gateConsumedUsd: estimatedCostUsd,
      balanceUsd: 100 - estimatedCostUsd * (index + 1),
      balanceRevision: String(index + 2),
    });
    expect(settlement.status).toBe(200);
  }

  const p50Ms = percentile(durationsMs, 0.5);
  const p95Ms = percentile(durationsMs, 0.95);
  expect(p50Ms).toBeLessThan(10);
  expect(p95Ms).toBeLessThan(25);

  if (process.env.REPORT_INFERENCE_BENCHMARK === "true") {
    process.stdout.write(
      `${JSON.stringify({
        benchmark: "inference_durable_object_rate_lease_and_dispatch",
        iterations,
        p50Ms: Number(p50Ms.toFixed(3)),
        p95Ms: Number(p95Ms.toFixed(3)),
      })}\n`,
    );
  }
});
