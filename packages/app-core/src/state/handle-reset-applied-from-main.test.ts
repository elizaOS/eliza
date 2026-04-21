import { describe, expect, it, vi } from "vitest";
import {
  type HandleResetAppliedFromMainDeps,
  handleResetAppliedFromMainCore,
} from "./handle-reset-applied-from-main";
import { parseAgentStatusFromMainMenuResetPayload } from "./parsers";

/* ---------- parseAgentStatusFromMainMenuResetPayload ---------- */

describe("parseAgentStatusFromMainMenuResetPayload", () => {
  it("parses valid payload with running agent status", () => {
    const result = parseAgentStatusFromMainMenuResetPayload({
      agentStatus: {
        state: "running",
        agentName: "Milady",
        model: "gpt-4",
        startedAt: 1000,
        uptime: 500,
      },
    });
    expect(result).toEqual({
      state: "running",
      agentName: "Milady",
      model: "gpt-4",
      startedAt: 1000,
      uptime: 500,
      startup: undefined,
    });
  });

  it("returns null for null payload", () => {
    expect(parseAgentStatusFromMainMenuResetPayload(null)).toBeNull();
  });

  it("returns null for undefined payload", () => {
    expect(parseAgentStatusFromMainMenuResetPayload(undefined)).toBeNull();
  });

  it("returns null for payload missing agentStatus key", () => {
    expect(parseAgentStatusFromMainMenuResetPayload({ foo: "bar" })).toBeNull();
  });

  it("returns null for array payload", () => {
    expect(parseAgentStatusFromMainMenuResetPayload([1, 2, 3])).toBeNull();
  });

  it("returns null when agentStatus is not a valid record", () => {
    expect(
      parseAgentStatusFromMainMenuResetPayload({ agentStatus: "invalid" }),
    ).toBeNull();
  });

  it("returns null when agentStatus has invalid state", () => {
    expect(
      parseAgentStatusFromMainMenuResetPayload({
        agentStatus: { state: "bogus", agentName: "Milady" },
      }),
    ).toBeNull();
  });

  it("returns null when agentStatus is missing agentName", () => {
    expect(
      parseAgentStatusFromMainMenuResetPayload({
        agentStatus: { state: "running" },
      }),
    ).toBeNull();
  });
});

/* ---------- handleResetAppliedFromMainCore ---------- */

describe("handleResetAppliedFromMainCore", () => {
  function makeDeps(
    overrides: Partial<HandleResetAppliedFromMainDeps> = {},
  ): HandleResetAppliedFromMainDeps {
    return {
      performanceNow: () => 0,
      isLifecycleBusy: () => false,
      getActiveLifecycleAction: () => "reset",
      beginLifecycleAction: vi.fn().mockReturnValue(true),
      finishLifecycleAction: vi.fn(),
      setActionNotice: vi.fn(),
      parseTrayResetPayload: (payload) =>
        parseAgentStatusFromMainMenuResetPayload(payload),
      completeResetLocalState: vi.fn().mockResolvedValue(undefined),
      alertDesktopMessage: vi.fn().mockResolvedValue(undefined),
      logResetInfo: vi.fn(),
      logResetWarn: vi.fn(),
      ...overrides,
    };
  }

  it("completes reset and shows success notice on happy path", async () => {
    const deps = makeDeps();
    await handleResetAppliedFromMainCore(
      {
        agentStatus: { state: "running", agentName: "Milady" },
      },
      deps,
    );

    expect(deps.beginLifecycleAction).toHaveBeenCalledWith("reset");
    expect(deps.completeResetLocalState).toHaveBeenCalled();
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("reset"),
      "success",
      expect.any(Number),
    );
    expect(deps.finishLifecycleAction).toHaveBeenCalled();
  });

  it("skips reset when lifecycle is busy", async () => {
    const deps = makeDeps({ isLifecycleBusy: () => true });
    await handleResetAppliedFromMainCore({ agentStatus: {} }, deps);

    expect(deps.beginLifecycleAction).not.toHaveBeenCalled();
    expect(deps.completeResetLocalState).not.toHaveBeenCalled();
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("already in progress"),
      "info",
      expect.any(Number),
    );
  });

  it("shows error notice and alerts desktop when completeResetLocalState fails", async () => {
    const deps = makeDeps({
      completeResetLocalState: vi
        .fn()
        .mockRejectedValue(new Error("DB wipe failed")),
    });
    await handleResetAppliedFromMainCore(
      { agentStatus: { state: "running", agentName: "Milady" } },
      deps,
    );

    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("DB wipe failed"),
      "error",
      expect.any(Number),
    );
    expect(deps.alertDesktopMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );
    expect(deps.finishLifecycleAction).toHaveBeenCalled();
  });

  it("returns early when beginLifecycleAction fails (concurrent op)", async () => {
    const deps = makeDeps({
      beginLifecycleAction: vi.fn().mockReturnValue(false),
    });
    await handleResetAppliedFromMainCore({ agentStatus: {} }, deps);

    expect(deps.completeResetLocalState).not.toHaveBeenCalled();
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("Another agent operation"),
      "info",
      expect.any(Number),
    );
  });

  it("always calls finishLifecycleAction even on error", async () => {
    const deps = makeDeps({
      completeResetLocalState: vi.fn().mockRejectedValue(new Error("boom")),
    });
    await handleResetAppliedFromMainCore(
      { agentStatus: { state: "running", agentName: "Milady" } },
      deps,
    );
    expect(deps.finishLifecycleAction).toHaveBeenCalled();
  });
});
