/**
 * Unit tests for SandboxRegistry. The Upstash REST client is mocked at the
 * module boundary (`@upstash/redis`) so we can record the exact key/value/TTL
 * triples that would be sent to Redis. Everything else runs the real
 * production code path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface PipelineCall {
  type: "set";
  key: string;
  value: string;
  opts?: { ex?: number };
}

interface DelCall {
  type: "del";
  keys: string[];
}

type RedisCall = PipelineCall | DelCall;

const mocks = vi.hoisted(() => ({
  calls: [] as RedisCall[],
  nextPipelineFails: false,
}));

vi.mock("@upstash/redis", () => {
  class FakePipeline {
    private willThrow: boolean;
    constructor(willThrow: boolean) {
      this.willThrow = willThrow;
    }
    set(key: string, value: string, opts?: { ex?: number }): this {
      if (!this.willThrow) {
        mocks.calls.push({ type: "set", key, value, opts });
      }
      return this;
    }
    async exec(): Promise<unknown[]> {
      if (this.willThrow) {
        throw new Error("simulated upstash failure");
      }
      return [];
    }
  }

  class FakeRedis {
    constructor(_config: { url: string; token: string }) {}
    pipeline(): FakePipeline {
      const willThrow = mocks.nextPipelineFails;
      mocks.nextPipelineFails = false;
      return new FakePipeline(willThrow);
    }
    async del(...keys: string[]): Promise<number> {
      mocks.calls.push({ type: "del", keys });
      return keys.length;
    }
  }

  return { Redis: FakeRedis };
});

vi.mock("@elizaos/core", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  buildSandboxRegistryFromEnv,
  SandboxRegistry,
} from "../sandbox-registry";

const CONFIG = {
  redisUrl: "https://example.upstash.io",
  redisToken: "tok",
  agentId: "agent-42",
  serverName: "sandbox-agent-42",
  serverUrl: "http://10.0.0.7:18791",
  ttlSeconds: 60,
};

describe("SandboxRegistry", () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.nextPipelineFails = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("register() writes both routing keys with the configured TTL", async () => {
    const registry = new SandboxRegistry(CONFIG);
    await registry.register();

    const sets = mocks.calls.filter((c) => c.type === "set") as PipelineCall[];
    expect(sets).toHaveLength(2);
    expect(sets[0]).toEqual({
      type: "set",
      key: "server:sandbox-agent-42:url",
      value: "http://10.0.0.7:18791",
      opts: { ex: 60 },
    });
    expect(sets[1]).toEqual({
      type: "set",
      key: "agent:agent-42:server",
      value: "sandbox-agent-42",
      opts: { ex: 60 },
    });
  });

  it("refresh() reissues the same two writes (idempotent)", async () => {
    const registry = new SandboxRegistry(CONFIG);
    await registry.register();
    mocks.calls.length = 0;

    await registry.refresh();

    const sets = mocks.calls.filter((c) => c.type === "set") as PipelineCall[];
    expect(sets).toHaveLength(2);
    expect(sets.map((s) => s.key)).toEqual([
      "server:sandbox-agent-42:url",
      "agent:agent-42:server",
    ]);
    expect(sets.every((s) => s.opts?.ex === 60)).toBe(true);
  });

  it("unregister() deletes both routing keys", async () => {
    const registry = new SandboxRegistry(CONFIG);
    await registry.register();
    mocks.calls.length = 0;

    await registry.unregister();

    const dels = mocks.calls.filter((c) => c.type === "del") as DelCall[];
    expect(dels).toHaveLength(1);
    expect(dels[0]?.keys).toEqual([
      "server:sandbox-agent-42:url",
      "agent:agent-42:server",
    ]);
  });

  it("startHeartbeat() refreshes on the interval; errors do not kill the timer", async () => {
    vi.useFakeTimers();
    const registry = new SandboxRegistry(CONFIG);
    await registry.register();
    mocks.calls.length = 0;

    registry.startHeartbeat(30_000);

    mocks.nextPipelineFails = true;
    await vi.advanceTimersByTimeAsync(30_000);
    // Failing tick: the FakePipeline.set short-circuits without recording when
    // willThrow is set, and exec() then rejects. The handler in
    // startHeartbeat caught the error so the next tick still runs.
    expect(mocks.calls.filter((c) => c.type === "set")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.calls.filter((c) => c.type === "set")).toHaveLength(2);

    registry.stopHeartbeat();
  });

  it("stopHeartbeat() halts the timer", async () => {
    vi.useFakeTimers();
    const registry = new SandboxRegistry(CONFIG);
    await registry.register();
    mocks.calls.length = 0;

    registry.startHeartbeat(30_000);
    registry.stopHeartbeat();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.calls).toHaveLength(0);
  });

  it("buildSandboxRegistryFromEnv() returns null when any required var is missing", () => {
    const complete = {
      SANDBOX_REGISTRY_REDIS_URL: "https://x.upstash.io",
      SANDBOX_REGISTRY_REDIS_TOKEN: "t",
      SANDBOX_AGENT_ID: "a",
      SANDBOX_SERVER_NAME: "s",
      SANDBOX_PUBLIC_URL: "http://1.2.3.4:1",
    };
    expect(buildSandboxRegistryFromEnv(complete)).not.toBeNull();

    for (const key of Object.keys(complete) as Array<keyof typeof complete>) {
      const partial = { ...complete, [key]: "" };
      expect(buildSandboxRegistryFromEnv(partial)).toBeNull();
    }
  });

  it("buildSandboxRegistryFromEnv() trims whitespace and rejects whitespace-only values", () => {
    expect(
      buildSandboxRegistryFromEnv({
        SANDBOX_REGISTRY_REDIS_URL: "https://x.upstash.io",
        SANDBOX_REGISTRY_REDIS_TOKEN: "t",
        SANDBOX_AGENT_ID: "a",
        SANDBOX_SERVER_NAME: "s",
        SANDBOX_PUBLIC_URL: "   ", // whitespace only
      }),
    ).toBeNull();
  });
});
