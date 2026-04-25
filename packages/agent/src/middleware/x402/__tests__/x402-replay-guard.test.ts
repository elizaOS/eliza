import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  replayGuardAbort,
  replayGuardCommit,
  replayGuardTryBegin,
} from "../x402-replay-guard.ts";

function uniq(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

describe("x402-replay-guard (in-memory TTL mode)", () => {
  beforeEach(() => {
    vi.stubEnv("X402_REPLAY_DURABLE", "0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks a second concurrent reservation for the same key", async () => {
    const k = uniq("k");
    expect(await replayGuardTryBegin([k])).toBe(true);
    expect(await replayGuardTryBegin([k])).toBe(false);
    replayGuardAbort([k]);
  });

  it("allows a new reservation after abort", async () => {
    const k = uniq("k");
    expect(await replayGuardTryBegin([k])).toBe(true);
    replayGuardAbort([k]);
    expect(await replayGuardTryBegin([k])).toBe(true);
    replayGuardAbort([k]);
  });

  it("blocks reuse after commit until TTL (still consumed)", async () => {
    const k = uniq("k");
    expect(await replayGuardTryBegin([k])).toBe(true);
    await replayGuardCommit([k]);
    expect(await replayGuardTryBegin([k])).toBe(false);
  });

  it("treats empty key list as a successful begin", async () => {
    expect(await replayGuardTryBegin([])).toBe(true);
    replayGuardAbort([]);
    await replayGuardCommit([]);
  });

  it("ignores mock runtime when durable is off (memory path only)", async () => {
    const k = uniq("k");
    const runtime = {
      getCache: vi.fn(),
      setCache: vi.fn(),
    } as unknown as AgentRuntime;
    expect(await replayGuardTryBegin([k], runtime, "aid")).toBe(true);
    await replayGuardCommit([k], runtime, "aid");
    expect(runtime.getCache).not.toHaveBeenCalled();
    expect(runtime.setCache).not.toHaveBeenCalled();
    replayGuardAbort([k]);
  });
});
