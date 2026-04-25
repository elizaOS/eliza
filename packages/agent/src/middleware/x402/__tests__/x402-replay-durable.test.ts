import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { durableReplayCacheKey } from "../x402-replay-durable.ts";
import {
  replayGuardAbortAsync,
  replayGuardCommit,
  replayGuardTryBegin,
} from "../x402-replay-guard.ts";

describe("x402 durable replay (runtime cache)", () => {
  beforeEach(() => {
    vi.stubEnv("X402_REPLAY_DURABLE", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("persists consumed credentials in runtime cache", async () => {
    const store = new Map<string, unknown>();
    const runtime = {
      getCache: vi.fn(async (key: string) => store.get(key)),
      setCache: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
        return true;
      }),
      deleteCache: vi.fn(async (key: string) => {
        store.delete(key);
        return true;
      }),
    } as unknown as AgentRuntime;

    const agentId = "00000000-0000-0000-0000-000000000099";
    const replayKey = `evm-tx:0x${"ab".repeat(32)}`;
    const cacheKey = durableReplayCacheKey(agentId, replayKey);

    expect(await replayGuardTryBegin([replayKey], runtime, agentId)).toBe(true);
    expect(await replayGuardTryBegin([replayKey], runtime, agentId)).toBe(
      false,
    );
    await replayGuardAbortAsync([replayKey], runtime, agentId);
    expect(await replayGuardTryBegin([replayKey], runtime, agentId)).toBe(true);

    await replayGuardCommit([replayKey], runtime, agentId);
    expect(store.has(cacheKey)).toBe(true);

    await replayGuardAbortAsync([replayKey], runtime, agentId);
    expect(await replayGuardTryBegin([replayKey], runtime, agentId)).toBe(
      false,
    );
  });

  it("uses SQL conditional insert/update when the runtime adapter exposes a database", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ key: "reserved" }] })
      .mockResolvedValueOnce({ rows: [{ key: "committed" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000098",
      adapter: {
        getConnection: vi.fn(async () => ({ execute })),
      },
      getCache: vi.fn(),
      setCache: vi.fn(),
    } as unknown as AgentRuntime;

    const replayKey = `evm-tx:0x${"cd".repeat(32)}`;
    expect(
      await replayGuardTryBegin([replayKey], runtime, runtime.agentId),
    ).toBe(true);
    await replayGuardCommit([replayKey], runtime, runtime.agentId);

    expect(
      await replayGuardTryBegin([replayKey], runtime, runtime.agentId),
    ).toBe(false);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(runtime.getCache).not.toHaveBeenCalled();
    expect(runtime.setCache).not.toHaveBeenCalled();
  });
});
