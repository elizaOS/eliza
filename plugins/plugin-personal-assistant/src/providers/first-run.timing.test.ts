/**
 * Exercises the real first-run provider, owner authorization, state store, and
 * inference timer. Backup listing and cache I/O are controlled collaborators;
 * an advancing clock proves which awaited boundary owns each recorded delay.
 */
import {
  ChannelType,
  type IAgentRuntime,
  InferenceTurnTimer,
  type Memory,
  runWithInferenceTiming,
  type State,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasOwnerAccess as realHasOwnerAccess } from "../../../../packages/agent/src/security/access.ts";
import type { FirstRunRecord } from "../lifeops/first-run/state.ts";
import { firstRunProvider } from "./first-run.ts";

const collaborators = vi.hoisted(() => ({
  ownerAccess: vi.fn(),
  backups: vi.fn(),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: collaborators.ownerAccess,
  listLocalAgentBackups: collaborators.backups,
}));

const ownerId = "00000000-0000-0000-0000-000000000001" as UUID;
const strangerId = "00000000-0000-0000-0000-000000000002" as UUID;
const agentId = "00000000-0000-0000-0000-000000000004" as UUID;
const state: State = { text: "", values: {}, data: {} };
const quiet = { text: "", values: { firstRunPending: false }, data: {} };
const spanNames = [
  "provider:firstRun:owner-access",
  "provider:firstRun:state-read",
  "provider:firstRun:backup-scan",
];
let now = 1_000;

function harness(record?: Partial<FirstRunRecord>) {
  const getCache = vi.fn(async () => {
    now += 17;
    return {
      status: "pending",
      partialAnswers: {},
      completionCount: 0,
      ...record,
    };
  });
  const runtime = {
    agentId,
    getCache,
    setCache: vi.fn(),
    deleteCache: vi.fn(),
    getSetting: vi.fn((key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? ownerId : undefined,
    ),
    getRoom: vi.fn(async () => null),
    reportError: vi.fn(),
    useModel: vi.fn(),
  } as unknown as IAgentRuntime;
  const message = {
    id: "00000000-0000-0000-0000-000000000003" as UUID,
    agentId,
    entityId: ownerId,
    roomId: ownerId,
    content: { text: "private incoming words", channelType: ChannelType.DM },
  } as Memory;
  const timer = new InferenceTurnTimer({
    turnId: "first-run-test",
    label: "test",
  });
  return { runtime, message, timer, getCache };
}

beforeEach(() => {
  now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  collaborators.ownerAccess
    .mockReset()
    .mockImplementation(async (runtime: IAgentRuntime, message: Memory) => {
      try {
        return await realHasOwnerAccess(runtime, message);
      } finally {
        now += 11;
      }
    });
  collaborators.backups.mockReset().mockImplementation(async () => {
    now += 23;
    return [];
  });
});

afterEach(() => vi.restoreAllMocks());

describe("first-run boundary timing", () => {
  it("attributes all three waits without changing the result or recording private data", async () => {
    const { runtime, message, timer, getCache } = harness();
    const result = await runWithInferenceTiming(timer, () =>
      firstRunProvider.get(runtime, message, state),
    );
    const summary = timer.close();
    expect(
      summary.spans.map(({ name, startMs, endMs, durationMs }) => ({
        name,
        startMs,
        endMs,
        durationMs,
      })),
    ).toEqual([
      { name: spanNames[0], startMs: 0, endMs: 11, durationMs: 11 },
      { name: spanNames[1], startMs: 11, endMs: 28, durationMs: 17 },
      { name: spanNames[2], startMs: 28, endMs: 51, durationMs: 23 },
    ]);
    expect(summary.spans.every((span) => span.meta === undefined)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(message.content.text);
    expect(getCache).toHaveBeenCalledExactlyOnceWith(
      "eliza:lifeops:first-run:v1",
    );
    expect(collaborators.ownerAccess).toHaveBeenCalledExactlyOnceWith(
      runtime,
      message,
    );
    expect(collaborators.backups).toHaveBeenCalledExactlyOnceWith(agentId);
    expect(runtime.setCache).not.toHaveBeenCalled();
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(result).toEqual(await firstRunProvider.get(runtime, message, state));
    expect(timer.summary().spans).toHaveLength(3);
    expect(collaborators.ownerAccess).toHaveBeenCalledTimes(2);
    expect(getCache).toHaveBeenCalledTimes(2);
  });

  it("denies a real non-owner before private state or backup reads", async () => {
    const { runtime, message, timer, getCache } = harness();
    message.entityId = strangerId;
    const result = await runWithInferenceTiming(timer, () =>
      firstRunProvider.get(runtime, message, state),
    );
    expect(result).toEqual(quiet);
    expect(getCache).not.toHaveBeenCalled();
    expect(collaborators.backups).not.toHaveBeenCalled();
    expect(timer.close().spans.map((span) => span.name)).toEqual([
      spanNames[0],
    ]);
  });

  it("reauthorizes after an owner change instead of reusing the private result", async () => {
    const { runtime, message, timer, getCache } = harness();
    await firstRunProvider.get(runtime, message, state);
    vi.mocked(runtime.getSetting).mockImplementation((key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? strangerId : undefined,
    );
    const result = await runWithInferenceTiming(timer, () =>
      firstRunProvider.get(runtime, message, state),
    );
    expect(result).toEqual(quiet);
    expect(collaborators.ownerAccess).toHaveBeenCalledTimes(2);
    expect(getCache).toHaveBeenCalledTimes(1);
    expect(collaborators.backups).toHaveBeenCalledTimes(1);
    expect(timer.close().spans.map((span) => span.name)).toEqual([
      spanNames[0],
    ]);
  });

  it("closes the owner span and preserves an authorization rejection", async () => {
    const { runtime, message, timer, getCache } = harness();
    const failure = new Error("authorization boundary unavailable");
    collaborators.ownerAccess.mockImplementationOnce(async () => {
      now += 11;
      throw failure;
    });
    await expect(
      runWithInferenceTiming(timer, () =>
        firstRunProvider.get(runtime, message, state),
      ),
    ).rejects.toBe(failure);
    expect(timer.close().spans).toMatchObject([
      { name: spanNames[0], durationMs: 11 },
    ]);
    expect(getCache).not.toHaveBeenCalled();
    expect(collaborators.backups).not.toHaveBeenCalled();
  });

  it("retains the quiet state-read failure outcome while recording the failed wait", async () => {
    const { runtime, message, timer, getCache } = harness();
    getCache.mockImplementationOnce(async () => {
      now += 17;
      throw new Error("cache unavailable");
    });
    const result = await runWithInferenceTiming(timer, () =>
      firstRunProvider.get(runtime, message, state),
    );
    expect(result).toEqual(quiet);
    expect(
      timer.close().spans.map(({ name, durationMs }) => ({ name, durationMs })),
    ).toEqual([
      { name: spanNames[0], durationMs: 11 },
      { name: spanNames[1], durationMs: 17 },
    ]);
    expect(collaborators.backups).not.toHaveBeenCalled();
  });

  it("retains the existing backup failure fallback and records its full delay", async () => {
    const { runtime, message, timer } = harness();
    collaborators.backups.mockImplementationOnce(async () => {
      now += 23;
      throw new Error("backup listing unavailable");
    });
    const result = await runWithInferenceTiming(timer, () =>
      firstRunProvider.get(runtime, message, state),
    );
    expect(result.values).toMatchObject({
      firstRunPending: true,
      firstRunLocalBackupAvailable: false,
    });
    expect(timer.close().spans.at(-1)).toMatchObject({
      name: spanNames[2],
      durationMs: 23,
    });
    expect(result).toEqual(await firstRunProvider.get(runtime, message, state));
  });

  it.each(["complete", "in_progress"] as const)(
    "does not introduce backup scans for %s state",
    async (status) => {
      const { runtime, message, timer } = harness({ status });
      const result = await runWithInferenceTiming(timer, () =>
        firstRunProvider.get(runtime, message, state),
      );
      expect(collaborators.backups).not.toHaveBeenCalled();
      expect(timer.close().spans.map((span) => span.name)).toEqual(
        spanNames.slice(0, 2),
      );
      expect(result).toEqual(
        await firstRunProvider.get(runtime, message, state),
      );
    },
  );
});
