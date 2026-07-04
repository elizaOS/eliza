/**
 * Fail-closed tests for the durable x402 replay-consumption commit path.
 *
 * A successfully-verified payment credential MUST be durably recorded as
 * "consumed"; if that record cannot be written (SQL UPDATE matched no reserved
 * row, or the cache write failed) the commit must NOT silently succeed — an
 * un-recorded consumption leaves the credential replayable once its inflight
 * reservation TTL lapses. These tests pin that `durableReplayCommitReservation`
 * (and `replayGuardCommit` on top of it) throw `X402ReplayCommitError` in those
 * cases, and stay quiet on the healthy commit.
 *
 * No real DB / cache is used — a hand-built fake runtime supplies a controllable
 * SQL `execute` (via `adapter.getConnection`) and `getCache`/`setCache`.
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  durableReplayCommitReservation,
  X402ReplayCommitError,
} from "./x402-replay-durable.js";
import { replayGuardCommit, replayGuardTryBegin } from "./x402-replay-guard.js";

type SqlRowsResult = { rowCount: number };

/**
 * Fake runtime whose SQL `execute` returns a caller-chosen rowCount. A shared
 * `phase` object lets a test make the reserve INSERT succeed (rows=1) and then
 * force the commit UPDATE to match no row (rows=0) to exercise the fail-closed
 * commit path against a genuinely-reserved credential.
 */
function makeSqlRuntime(opts: {
  agentId?: string;
  updateRowCount: number;
  phase?: { commitRowCount: number };
}): AgentRuntime {
  const execute = vi.fn(async () => ({
    rowCount: opts.phase ? opts.phase.commitRowCount : opts.updateRowCount,
  })) as unknown as (query: unknown) => Promise<SqlRowsResult>;
  const db = { execute };
  return {
    agentId: opts.agentId ?? "agent-1",
    adapter: {
      getConnection: vi.fn(async () => db),
    },
    // Cache path is not reached when a SQL connection is available.
    getCache: vi.fn(async () => undefined),
    setCache: vi.fn(async () => true),
    deleteCache: vi.fn(async () => true),
  } as unknown as AgentRuntime;
}

/** Fake runtime with NO SQL connection, forcing the cache fallback path. */
function makeCacheRuntime(opts: { setCacheOk: boolean }): AgentRuntime {
  const store = new Map<string, unknown>();
  return {
    agentId: "agent-1",
    adapter: {
      // No `.execute` => getSqlDb returns null => cache fallback is used.
      getConnection: vi.fn(async () => ({})),
    },
    getCache: vi.fn(async (k: string) => store.get(k)),
    setCache: vi.fn(async (k: string, v: unknown) => {
      if (!opts.setCacheOk) return false;
      store.set(k, v);
      return true;
    }),
    deleteCache: vi.fn(async (k: string) => {
      store.delete(k);
      return true;
    }),
  } as unknown as AgentRuntime;
}

describe("durableReplayCommitReservation fail-closed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.X402_REPLAY_DURABLE;
  });

  it("commits quietly when the SQL UPDATE marks the reserved row consumed", async () => {
    const runtime = makeSqlRuntime({ updateRowCount: 1 });
    await expect(
      durableReplayCommitReservation(
        runtime,
        "agent-1",
        ["proof-a"],
        "owner-1",
      ),
    ).resolves.toBeUndefined();
  });

  it("throws X402ReplayCommitError when the SQL commit matches no reserved row", async () => {
    // rowCount 0 => the inflight row was stolen/released/already-committed; the
    // credential is NOT recorded consumed and would be replayable after TTL.
    const runtime = makeSqlRuntime({ updateRowCount: 0 });
    await expect(
      durableReplayCommitReservation(
        runtime,
        "agent-1",
        ["proof-b"],
        "owner-1",
      ),
    ).rejects.toBeInstanceOf(X402ReplayCommitError);
  });

  it("reports the exact un-consumed keys on a partial SQL commit failure", async () => {
    const runtime = makeSqlRuntime({ updateRowCount: 0 });
    let caught: unknown;
    try {
      await durableReplayCommitReservation(
        runtime,
        "agent-1",
        ["k1", "k2"],
        "owner-1",
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(X402ReplayCommitError);
    // Both keys map to distinct cache rows; both failed to commit.
    expect((caught as X402ReplayCommitError).replayKeys).toHaveLength(2);
  });

  it("throws when the cache-fallback setCache cannot persist consumption", async () => {
    const runtime = makeCacheRuntime({ setCacheOk: false });
    await expect(
      durableReplayCommitReservation(
        runtime,
        "agent-1",
        ["proof-c"],
        undefined,
      ),
    ).rejects.toBeInstanceOf(X402ReplayCommitError);
  });

  it("commits quietly on the cache-fallback path when setCache succeeds", async () => {
    const runtime = makeCacheRuntime({ setCacheOk: true });
    await expect(
      durableReplayCommitReservation(
        runtime,
        "agent-1",
        ["proof-d"],
        undefined,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("replayGuardCommit propagates the durable fail-closed error", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.X402_REPLAY_DURABLE;
  });

  it("throws (denies the unlock) and keeps the in-process reservation on commit failure", async () => {
    // Reserve INSERT succeeds (rows=1), then flip commit UPDATE to rows=0.
    const phase = { commitRowCount: 1 };
    const runtime = makeSqlRuntime({ updateRowCount: 1, phase });
    const keys = ["guard-proof-fail"];

    // Reserve so replayGuardCommit has an in-process owner to work with.
    await expect(replayGuardTryBegin(keys, runtime, "agent-1")).resolves.toBe(
      true,
    );

    // Now the commit UPDATE will match no reserved row.
    phase.commitRowCount = 0;

    // Commit cannot persist consumption -> must throw so the payment boundary
    // returns 402 instead of unlocking a route the guard can't back.
    await expect(
      replayGuardCommit(keys, runtime, "agent-1"),
    ).rejects.toBeInstanceOf(X402ReplayCommitError);

    // The in-process inflight guard is retained on failure, so a same-process
    // retry with the same credential is still blocked (returns false).
    await expect(replayGuardTryBegin(keys, runtime, "agent-1")).resolves.toBe(
      false,
    );
  });

  it("commits without throwing when the durable write succeeds", async () => {
    const runtime = makeSqlRuntime({ updateRowCount: 1 });
    const keys = ["guard-proof-ok"];
    await expect(replayGuardTryBegin(keys, runtime, "agent-1")).resolves.toBe(
      true,
    );
    await expect(
      replayGuardCommit(keys, runtime, "agent-1"),
    ).resolves.toBeUndefined();
  });
});
