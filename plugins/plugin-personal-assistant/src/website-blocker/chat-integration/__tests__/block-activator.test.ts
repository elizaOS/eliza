import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSelfControlStatus,
  startSelfControlBlock,
  stopSelfControlBlock,
  syncWebsiteBlockerExpiryTask,
} = vi.hoisted(() => ({
  getSelfControlStatus: vi.fn(),
  startSelfControlBlock: vi.fn(),
  stopSelfControlBlock: vi.fn(),
  syncWebsiteBlockerExpiryTask: vi.fn(),
}));

vi.mock("@elizaos/plugin-blocker/services/website-blocker/index", () => ({
  getSelfControlStatus,
  startSelfControlBlock,
  stopSelfControlBlock,
  syncWebsiteBlockerExpiryTask,
  normalizeWebsiteTargets: (rawTargets: readonly string[]): string[] => {
    const seen = new Set<string>();
    for (const raw of rawTargets) {
      const trimmed = String(raw)
        .trim()
        .replace(/[),.!?]{1,64}$/g, "");
      if (trimmed) seen.add(trimmed);
    }
    return [...seen];
  },
}));

import {
  activateBlockRule,
  BLOCK_RULES_MANAGED_BY,
  syncOsBlockToRules,
} from "../block-activator.js";
import type { BlockRule } from "../block-rule-schema.js";

const MIN = 60_000;

function timedRule(overrides: Partial<BlockRule> = {}): BlockRule {
  return {
    id: "rule-1",
    agentId: "agent-1",
    profile: "test",
    websites: ["x.com"],
    gateType: "fixed_duration",
    gateTodoId: null,
    gateUntilMs: null,
    fixedDurationMs: 30 * MIN,
    unlockDurationMs: null,
    active: true,
    createdAt: 1_000_000,
    releasedAt: null,
    releasedReason: null,
    ...overrides,
  };
}

function untilTodoRule(overrides: Partial<BlockRule> = {}): BlockRule {
  return timedRule({
    id: "rule-2",
    gateType: "until_todo",
    gateTodoId: "todo-1",
    fixedDurationMs: null,
    ...overrides,
  });
}

function activeStatus(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    active: true,
    hostsFilePath: "/tmp/hosts",
    startedAt: "2026-08-26T00:00:00.000Z",
    endsAt: new Date(1_000_000 + 30 * MIN).toISOString(),
    websites: ["x.com"],
    blockedWebsites: ["x.com"],
    allowedWebsites: [],
    requestedWebsites: ["x.com"],
    matchMode: "exact",
    managedBy: BLOCK_RULES_MANAGED_BY,
    metadata: { managedBy: BLOCK_RULES_MANAGED_BY },
    scheduledByAgentId: "agent-1",
    canUnblockEarly: true,
    requiresElevation: false,
    engine: "mock",
    platform: "linux",
    supportsElevationPrompt: false,
    elevationPromptMethod: null,
    reason: null,
    ...overrides,
  };
}

const runtime = { agentId: "agent-1" } as never;

describe("activateBlockRule", () => {
  it("rolls the OS block back when the expiry task cannot be scheduled", async () => {
    startSelfControlBlock.mockResolvedValue({
      success: true,
      endsAt: new Date(1_000_000 + 30 * MIN).toISOString(),
    } as never);
    stopSelfControlBlock.mockResolvedValue({
      success: true,
      endedAt: new Date().toISOString(),
    } as never);
    syncWebsiteBlockerExpiryTask.mockResolvedValue(null as never);

    const result = await activateBlockRule({
      runtime,
      websites: ["x.com"],
      durationMinutes: 30,
    });

    expect(result.success).toBe(false);
    expect(stopSelfControlBlock).toHaveBeenCalledTimes(1);
  });
});

describe("syncOsBlockToRules", () => {
  beforeEach(() => {
    getSelfControlStatus.mockReset();
    startSelfControlBlock.mockReset();
    stopSelfControlBlock.mockReset();
    syncWebsiteBlockerExpiryTask.mockReset();
    getSelfControlStatus.mockImplementation(async () => activeStatus());
    startSelfControlBlock.mockImplementation(
      async (request: { durationMinutes: number | null }) => ({
        success: true,
        endsAt:
          request.durationMinutes === null
            ? null
            : new Date(
                Date.now() + request.durationMinutes * MIN,
              ).toISOString(),
      }),
    );
    stopSelfControlBlock.mockImplementation(async () => ({
      success: true,
      endedAt: new Date().toISOString(),
    }));
    syncWebsiteBlockerExpiryTask.mockResolvedValue("task-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stops a rule-managed block when no active rules remain", async () => {
    const result = await syncOsBlockToRules(runtime, [], 1_000_000);

    expect(result).toEqual({ ok: true, changed: true, error: null });
    expect(stopSelfControlBlock).toHaveBeenCalledTimes(1);
    expect(startSelfControlBlock).not.toHaveBeenCalled();
  });

  it("leaves a foreign (manually started) block alone when rules clear", async () => {
    getSelfControlStatus.mockImplementation(async () =>
      activeStatus({ managedBy: null, metadata: null }),
    );

    const result = await syncOsBlockToRules(runtime, [], 1_000_000);

    expect(result).toEqual({ ok: true, changed: false, error: null });
    expect(stopSelfControlBlock).not.toHaveBeenCalled();
  });

  it("refuses to engage a foreign block when rules are active", async () => {
    getSelfControlStatus.mockImplementation(async () =>
      activeStatus({ managedBy: null, metadata: null }),
    );

    const result = await syncOsBlockToRules(runtime, [timedRule()], 1_000_000);

    expect(result.ok).toBe(false);
    expect(result.changed).toBe(false);
    expect(stopSelfControlBlock).not.toHaveBeenCalled();
    expect(startSelfControlBlock).not.toHaveBeenCalled();
  });

  it("starts a timed block from scratch when nothing is running", async () => {
    getSelfControlStatus.mockImplementation(async () =>
      activeStatus({ active: false }),
    );

    const result = await syncOsBlockToRules(runtime, [timedRule()], 1_000_000);

    expect(result).toEqual({ ok: true, changed: true, error: null });
    expect(startSelfControlBlock).toHaveBeenCalledTimes(1);
    expect(startSelfControlBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        websites: ["x.com"],
        durationMinutes: 30,
        metadata: { managedBy: BLOCK_RULES_MANAGED_BY },
      }),
    );
  });

  it("starts an indefinite block when any rule has no time bound", async () => {
    getSelfControlStatus.mockImplementation(async () =>
      activeStatus({ active: false }),
    );

    const result = await syncOsBlockToRules(
      runtime,
      [untilTodoRule()],
      1_000_000,
    );

    expect(result).toEqual({ ok: true, changed: true, error: null });
    expect(startSelfControlBlock).toHaveBeenCalledWith(
      expect.objectContaining({ durationMinutes: null }),
    );
  });

  it("keeps an already-matching timed block unchanged", async () => {
    const result = await syncOsBlockToRules(runtime, [timedRule()], 1_000_000);

    expect(result).toEqual({ ok: true, changed: false, error: null });
    expect(stopSelfControlBlock).not.toHaveBeenCalled();
    expect(startSelfControlBlock).not.toHaveBeenCalled();
  });

  it("reshapes when a rule demands indefinite blocking over the same websites", async () => {
    // The running block is timed (ends in 30 min) but a newly active
    // until_todo rule requires an indefinite block over the SAME sites.
    const result = await syncOsBlockToRules(
      runtime,
      [timedRule(), untilTodoRule()],
      1_000_000,
    );

    expect(result).toEqual({ ok: true, changed: true, error: null });
    expect(stopSelfControlBlock).toHaveBeenCalledTimes(1);
    expect(startSelfControlBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        websites: ["x.com"],
        durationMinutes: null,
      }),
    );
  });

  it("extends a timed block when a longer fixed rule covers the same websites", async () => {
    const result = await syncOsBlockToRules(
      runtime,
      [
        timedRule(),
        timedRule({
          id: "rule-3",
          fixedDurationMs: 120 * MIN,
          createdAt: 1_000_000,
        }),
      ],
      1_000_000,
    );

    expect(result).toEqual({ ok: true, changed: true, error: null });
    expect(stopSelfControlBlock).toHaveBeenCalledTimes(1);
    expect(startSelfControlBlock).toHaveBeenCalledWith(
      expect.objectContaining({ durationMinutes: 120 }),
    );
  });

  it("keeps an indefinite block when it already covers the rules", async () => {
    getSelfControlStatus.mockImplementation(async () =>
      activeStatus({ endsAt: null }),
    );

    const result = await syncOsBlockToRules(
      runtime,
      [untilTodoRule()],
      1_000_000,
    );

    expect(result).toEqual({ ok: true, changed: false, error: null });
    expect(stopSelfControlBlock).not.toHaveBeenCalled();
    expect(startSelfControlBlock).not.toHaveBeenCalled();
  });

  it("reshapes when the website set changes", async () => {
    getSelfControlStatus.mockImplementation(async () =>
      activeStatus({ requestedWebsites: ["x.com", "y.com"] }),
    );

    const result = await syncOsBlockToRules(runtime, [timedRule()], 1_000_000);

    expect(result).toEqual({ ok: true, changed: true, error: null });
    expect(stopSelfControlBlock).toHaveBeenCalledTimes(1);
    expect(startSelfControlBlock).toHaveBeenCalledWith(
      expect.objectContaining({ websites: ["x.com"] }),
    );
  });

  it("reports failure when the reshape stop fails", async () => {
    stopSelfControlBlock.mockResolvedValue({
      success: false,
      error: "no admin permission",
    } as never);

    const result = await syncOsBlockToRules(
      runtime,
      [timedRule(), untilTodoRule()],
      1_000_000,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("no admin permission");
    expect(startSelfControlBlock).not.toHaveBeenCalled();
  });
});
