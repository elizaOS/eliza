/**
 * Measures the strongly ordered onboarding turn path without pass/fail gates.
 * The harness uses real state-machine and Durable Object code with an
 * in-memory storage implementation so results isolate application overhead.
 */

import { OnboardingSessionCoordinator } from "../src/onboarding-session-coordinator";

class BenchmarkStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put(
    key: string | Record<string, unknown>,
    value?: unknown,
  ): Promise<void> {
    if (typeof key === "string") {
      this.values.set(key, structuredClone(value));
      return;
    }
    for (const [entryKey, entryValue] of Object.entries(key)) {
      this.values.set(entryKey, structuredClone(entryValue));
    }
  }

  async delete(key: string | string[]): Promise<boolean> {
    const keys = typeof key === "string" ? [key] : key;
    return keys.map((entry) => this.values.delete(entry)).some(Boolean);
  }

  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }

  async getAlarm(): Promise<number | null> {
    return null;
  }

  async setAlarm(_timestamp: number): Promise<void> {}

  async deleteAlarm(): Promise<void> {}

  async transaction<T>(
    operation: (transaction: BenchmarkStorage) => Promise<T>,
  ): Promise<T> {
    return operation(this);
  }
}

function createHarness(): (name: string) => OnboardingSessionCoordinator {
  const objects = new Map<string, OnboardingSessionCoordinator>();
  const env: Record<string, unknown> = {
    CEREBRAS_API_KEY: "configured-but-unused",
  };
  const objectByName = (name: string): OnboardingSessionCoordinator => {
    let object = objects.get(name);
    if (!object) {
      object = new OnboardingSessionCoordinator(
        { storage: new BenchmarkStorage() } as unknown as DurableObjectState,
        env as never,
      );
      objects.set(name, object);
    }
    return object;
  };
  env.ONBOARDING_SESSIONS = {
    getByName: (name: string) => ({
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        objectByName(name).fetch(new Request(input, init)),
    }),
  };
  return objectByName;
}

async function turn(
  coordinator: OnboardingSessionCoordinator,
  message: string,
  idempotencyKey: string,
): Promise<void> {
  const response = await coordinator.fetch(
    new Request("https://onboarding.benchmark/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "platform:discord:benchmark-user",
        input: {
          sessionId: "platform:discord:benchmark-user",
          message,
          platform: "discord",
          platformUserId: "benchmark-user",
          platformDisplayName: "Benchmark User",
          trustedPlatformIdentity: true,
          idempotencyKey,
        },
      }),
    }),
  );
  if (!response.ok) {
    throw new Error(
      `benchmark turn failed (${response.status}): ${await response.text()}`,
    );
  }
  await response.arrayBuffer();
}

function summarize(samples: number[]): Record<string, number> {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0;
  const rounded = (value: number): number => Number(value.toFixed(3));
  return {
    count: samples.length,
    meanMs: rounded(
      samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
    ),
    p50Ms: rounded(percentile(0.5)),
    p95Ms: rounded(percentile(0.95)),
    maxMs: rounded(sorted.at(-1) ?? 0),
  };
}

async function sample(operation: () => Promise<void>): Promise<number> {
  const startedAt = performance.now();
  await operation();
  return performance.now() - startedAt;
}

const objectByName = createHarness();
const coordinator = objectByName("platform:discord:benchmark-user");
const coldTurnMs = await sample(() =>
  turn(coordinator, "My name is Benchmark User", "discord:cold"),
);

const uniqueSamples: number[] = [];
for (let index = 0; index < 100; index += 1) {
  uniqueSamples.push(
    await sample(() =>
      turn(coordinator, `unique turn ${index}`, `discord:unique-${index}`),
    ),
  );
}

const replaySamples: number[] = [];
for (let index = 0; index < 100; index += 1) {
  replaySamples.push(
    await sample(() =>
      turn(coordinator, "ignored replay body", "discord:unique-99"),
    ),
  );
}

const burstStartedAt = performance.now();
const burstSamples = await Promise.all(
  Array.from({ length: 32 }, (_, index) =>
    sample(() =>
      turn(coordinator, `burst turn ${index}`, `discord:burst-${index}`),
    ),
  ),
);
const burstWallMs = performance.now() - burstStartedAt;

process.stdout.write(
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runtime: `bun ${Bun.version}`,
      modelConfiguration:
        "CEREBRAS_API_KEY present; onboarding performs zero model calls",
      coldTurnMs: Number(coldTurnMs.toFixed(3)),
      sequentialUnique: summarize(uniqueSamples),
      cachedReplay: summarize(replaySamples),
      parallelBurst: {
        concurrency: burstSamples.length,
        wallMs: Number(burstWallMs.toFixed(3)),
        perRequest: summarize(burstSamples),
      },
    },
    null,
    2,
  )}\n`,
);
process.exit(0);
