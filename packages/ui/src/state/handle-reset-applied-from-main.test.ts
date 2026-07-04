/**
 * Unit coverage for the desktop main-process reset-applied handler that resets
 * renderer lifecycle state. Deps injected, no harness.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentStatus } from "../api/client";
import {
  type HandleResetAppliedFromMainDeps,
  handleResetAppliedFromMainCore,
} from "./handle-reset-applied-from-main";
import { LIFECYCLE_MESSAGES, type LifecycleAction } from "./types";

const PARSED_STATUS: AgentStatus = {
  state: "stopped",
  agentName: "test-agent",
  model: undefined,
  uptime: undefined,
  startedAt: undefined,
};

function buildDeps(
  overrides: Partial<HandleResetAppliedFromMainDeps> = {},
): HandleResetAppliedFromMainDeps {
  return {
    performanceNow: vi.fn(() => 0),
    isLifecycleBusy: vi.fn(() => false),
    getActiveLifecycleAction: vi.fn<() => LifecycleAction>(() => "reset"),
    beginLifecycleAction: vi.fn(() => true),
    finishLifecycleAction: vi.fn(),
    setActionNotice: vi.fn(),
    parseTrayResetPayload: vi.fn(() => PARSED_STATUS),
    completeResetLocalState: vi.fn(async () => {}),
    alertDesktopMessage: vi.fn(async () => {}),
    logResetInfo: vi.fn(),
    logResetWarn: vi.fn(),
    ...overrides,
  };
}

describe("handleResetAppliedFromMainCore", () => {
  it("skips when a lifecycle action is already in progress", async () => {
    const deps = buildDeps({
      isLifecycleBusy: vi.fn(() => true),
      getActiveLifecycleAction: vi.fn<() => LifecycleAction>(() => "start"),
    });

    await handleResetAppliedFromMainCore({}, deps);

    expect(deps.setActionNotice).toHaveBeenCalledWith(
      `Agent action already in progress (${LIFECYCLE_MESSAGES.start.inProgress}). Please wait.`,
      "info",
      2800,
    );
    expect(deps.beginLifecycleAction).not.toHaveBeenCalled();
    expect(deps.completeResetLocalState).not.toHaveBeenCalled();
    expect(deps.finishLifecycleAction).not.toHaveBeenCalled();
  });

  it("aborts when the reset lifecycle action cannot be claimed", async () => {
    const deps = buildDeps({
      beginLifecycleAction: vi.fn(() => false),
    });

    await handleResetAppliedFromMainCore({}, deps);

    expect(deps.setActionNotice).toHaveBeenCalledWith(
      "Another agent operation is still running. Wait for it to finish, then try Reset again.",
      "info",
      4200,
    );
    expect(deps.completeResetLocalState).not.toHaveBeenCalled();
    expect(deps.finishLifecycleAction).not.toHaveBeenCalled();
  });

  it("parses the payload, completes the reset, and reports success", async () => {
    const payload = { kind: "menu-reset-app-applied" };
    const deps = buildDeps();

    await handleResetAppliedFromMainCore(payload, deps);

    expect(deps.beginLifecycleAction).toHaveBeenCalledWith("reset");
    expect(deps.parseTrayResetPayload).toHaveBeenCalledWith(payload);
    expect(deps.completeResetLocalState).toHaveBeenCalledWith(PARSED_STATUS);
    expect(deps.setActionNotice).toHaveBeenCalledWith(
      LIFECYCLE_MESSAGES.reset.success,
      "success",
      3200,
    );
    expect(deps.alertDesktopMessage).not.toHaveBeenCalled();
    expect(deps.finishLifecycleAction).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failure notice, alerts the shell, and still releases the lifecycle", async () => {
    const deps = buildDeps({
      completeResetLocalState: vi.fn(async () => {
        throw new Error("renderer wipe exploded");
      }),
    });

    await handleResetAppliedFromMainCore({}, deps);

    expect(deps.setActionNotice).toHaveBeenCalledWith(
      `Failed to ${LIFECYCLE_MESSAGES.reset.verb} agent: renderer wipe exploded`,
      "error",
      4200,
    );
    expect(deps.alertDesktopMessage).toHaveBeenCalledWith({
      title: "Reset Failed",
      message: "Reset ran in the desktop shell but the UI could not refresh.",
      type: "error",
    });
    // The `finally` block must release the lifecycle even on failure.
    expect(deps.finishLifecycleAction).toHaveBeenCalledTimes(1);
  });
});
