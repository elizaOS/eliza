// @vitest-environment jsdom

/**
 * Phase-event and terminal-status contract of the cloud-agent handoff runner.
 * The supervisor is stubbed so the test can assert the emitted phase sequence
 * (migrating → terminal), retry arming on failure, and that `onSwitchSucceeded`
 * fires only on the success statuses (`switched` / `switched-empty`) — never on
 * `failed` or `timed-out`, where the user stays on the shared bridge.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_HANDOFF_PHASE_EVENT,
  type CloudHandoffPhaseDetail,
  dispatchCloudHandoffRetry,
} from "../../events";
import type { ConversationHandoffResult } from "./conversation-handoff";
import {
  isInsufficientCreditsError,
  runCloudAgentHandoff,
} from "./run-cloud-agent-handoff";

function collectPhases(): {
  phases: CloudHandoffPhaseDetail[];
  stop: () => void;
} {
  const phases: CloudHandoffPhaseDetail[] = [];
  const onPhase = (event: Event) => {
    phases.push((event as CustomEvent<CloudHandoffPhaseDetail>).detail);
  };
  window.addEventListener(CLOUD_HANDOFF_PHASE_EVENT, onPhase);
  return {
    phases,
    stop: () => window.removeEventListener(CLOUD_HANDOFF_PHASE_EVENT, onPhase),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("runCloudAgentHandoff", () => {
  afterEach(() => vi.restoreAllMocks());

  it("dispatches migrating then the supervisor's terminal status", async () => {
    const { phases, stop } = collectPhases();
    const start = vi.fn(
      async (): Promise<ConversationHandoffResult> => ({
        status: "switched",
        imported: 3,
      }),
    );

    runCloudAgentHandoff("a1", start);
    await flush();
    stop();

    expect(start).toHaveBeenCalledTimes(1);
    expect(phases.map((p) => p.phase)).toEqual(["migrating", "switched"]);
    expect(phases[1]).toMatchObject({ agentId: "a1", imported: 3 });
  });

  it("maps a thrown 402 to the distinct insufficient-credits phase (not a generic failed)", async () => {
    const { phases, stop } = collectPhases();
    // The dedicated-agent create is refused by the credit gate; the direct-cloud
    // client tags the rejection with status 402 (see api/client-cloud.ts).
    const start = vi.fn(async (): Promise<ConversationHandoffResult> => {
      throw Object.assign(new Error("insufficient credits"), { status: 402 });
    });

    runCloudAgentHandoff("a402", start);
    await flush();
    stop();

    expect(phases.map((p) => p.phase)).toEqual([
      "migrating",
      "insufficient-credits",
    ]);
    expect(phases[1]?.error).toBe("insufficient credits");
  });

  it("still arms a retry on insufficient-credits so add-credits → retry upgrades", async () => {
    const { phases, stop } = collectPhases();
    const start = vi
      .fn<() => Promise<ConversationHandoffResult>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("insufficient credits"), { status: 402 }),
      )
      .mockResolvedValueOnce({ status: "switched", imported: 2 });

    runCloudAgentHandoff("a402b", start);
    await flush();
    expect(start).toHaveBeenCalledTimes(1);

    // The user adds credits, then retries: the second create succeeds and the
    // handoff completes onto the dedicated agent.
    dispatchCloudHandoffRetry({ agentId: "a402b" });
    await flush();
    stop();

    expect(start).toHaveBeenCalledTimes(2);
    expect(phases.map((p) => p.phase)).toEqual([
      "migrating",
      "insufficient-credits",
      "migrating",
      "switched",
    ]);
  });

  it("isInsufficientCreditsError detects only a 402-tagged error", () => {
    expect(
      isInsufficientCreditsError(
        Object.assign(new Error("nope"), { status: 402 }),
      ),
    ).toBe(true);
    expect(
      isInsufficientCreditsError(
        Object.assign(new Error("server"), { status: 500 }),
      ),
    ).toBe(false);
    expect(isInsufficientCreditsError(new Error("plain"))).toBe(false);
    expect(isInsufficientCreditsError(null)).toBe(false);
    expect(isInsufficientCreditsError("402")).toBe(false);
  });

  it("maps a thrown supervisor to a failed phase carrying the message", async () => {
    const { phases, stop } = collectPhases();
    const start = vi.fn(async (): Promise<ConversationHandoffResult> => {
      throw new Error("container never came up");
    });

    runCloudAgentHandoff("a2", start);
    await flush();
    stop();

    expect(phases.map((p) => p.phase)).toEqual(["migrating", "failed"]);
    expect(phases[1]?.error).toBe("container never came up");
  });

  it("arms a retry on failure that re-runs the supervisor for that agent only", async () => {
    const { phases, stop } = collectPhases();
    const start = vi
      .fn<() => Promise<ConversationHandoffResult>>()
      .mockResolvedValueOnce({ status: "timed-out", imported: 0 })
      .mockResolvedValueOnce({ status: "switched", imported: 1 });

    runCloudAgentHandoff("a3", start);
    await flush();
    expect(start).toHaveBeenCalledTimes(1);

    // A retry for a different agent is ignored.
    dispatchCloudHandoffRetry({ agentId: "other" });
    await flush();
    expect(start).toHaveBeenCalledTimes(1);

    // Retrying this agent re-runs the supervisor and succeeds.
    dispatchCloudHandoffRetry({ agentId: "a3" });
    await flush();
    stop();

    expect(start).toHaveBeenCalledTimes(2);
    expect(phases.map((p) => p.phase)).toEqual([
      "migrating",
      "timed-out",
      "migrating",
      "switched",
    ]);
  });

  // PR4 — the shared-bridge delete is a DESTRUCTIVE op, so its gating is
  // safety-critical: it must fire ONLY on a confirmed-successful switch and
  // NEVER on a non-success / uncertain terminal phase (the user is still on the
  // shared bridge, so deleting it would lose their conversation).
  it("fires onSwitchSucceeded on `switched` (success — safe to delete shared)", async () => {
    const { stop } = collectPhases();
    const start = vi.fn(
      async (): Promise<ConversationHandoffResult> => ({
        status: "switched",
        imported: 2,
      }),
    );
    const onSwitchSucceeded = vi.fn();

    runCloudAgentHandoff("a5", start, onSwitchSucceeded);
    await flush();
    stop();

    expect(onSwitchSucceeded).toHaveBeenCalledTimes(1);
  });

  it("fires onSwitchSucceeded on `switched-empty` (success, nothing to copy)", async () => {
    const { stop } = collectPhases();
    const start = vi.fn(
      async (): Promise<ConversationHandoffResult> => ({
        status: "switched-empty",
        imported: 0,
      }),
    );
    const onSwitchSucceeded = vi.fn();

    runCloudAgentHandoff("a6", start, onSwitchSucceeded);
    await flush();
    stop();

    expect(onSwitchSucceeded).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onSwitchSucceeded on `timed-out` (user still on the shared bridge)", async () => {
    const { stop } = collectPhases();
    const start = vi.fn(
      async (): Promise<ConversationHandoffResult> => ({
        status: "timed-out",
        imported: 0,
      }),
    );
    const onSwitchSucceeded = vi.fn();

    runCloudAgentHandoff("a7", start, onSwitchSucceeded);
    await flush();
    stop();

    expect(onSwitchSucceeded).not.toHaveBeenCalled();
  });

  it("does NOT fire onSwitchSucceeded on `failed`", async () => {
    const { stop } = collectPhases();
    const start = vi.fn(
      async (): Promise<ConversationHandoffResult> => ({
        status: "failed",
        imported: 0,
        error: "import failed",
      }),
    );
    const onSwitchSucceeded = vi.fn();

    runCloudAgentHandoff("a8", start, onSwitchSucceeded);
    await flush();
    stop();

    expect(onSwitchSucceeded).not.toHaveBeenCalled();
  });

  it("does NOT fire onSwitchSucceeded when the supervisor throws", async () => {
    const { stop } = collectPhases();
    const start = vi.fn(async (): Promise<ConversationHandoffResult> => {
      throw new Error("container never came up");
    });
    const onSwitchSucceeded = vi.fn();

    runCloudAgentHandoff("a9", start, onSwitchSucceeded);
    await flush();
    stop();

    expect(onSwitchSucceeded).not.toHaveBeenCalled();
  });

  it("swallows an onSwitchSucceeded rejection (a leaked-row delete never throws upward)", async () => {
    const { stop } = collectPhases();
    const start = vi.fn(
      async (): Promise<ConversationHandoffResult> => ({
        status: "switched",
        imported: 1,
      }),
    );
    const onSwitchSucceeded = vi.fn(async () => {
      throw new Error("delete failed");
    });

    expect(() =>
      runCloudAgentHandoff("a10", start, onSwitchSucceeded),
    ).not.toThrow();
    await flush();
    stop();

    expect(onSwitchSucceeded).toHaveBeenCalledTimes(1);
  });

  it("does not fire onSwitchSucceeded on the failed leg of a retry, only on the successful one", async () => {
    const { stop } = collectPhases();
    const start = vi
      .fn<() => Promise<ConversationHandoffResult>>()
      .mockResolvedValueOnce({ status: "timed-out", imported: 0 })
      .mockResolvedValueOnce({ status: "switched", imported: 1 });
    const onSwitchSucceeded = vi.fn();

    runCloudAgentHandoff("a11", start, onSwitchSucceeded);
    await flush();
    expect(onSwitchSucceeded).not.toHaveBeenCalled();

    dispatchCloudHandoffRetry({ agentId: "a11" });
    await flush();
    stop();

    expect(onSwitchSucceeded).toHaveBeenCalledTimes(1);
  });

  it("drops the armed retry listener after the TTL so an un-retried handoff doesn't leak it", async () => {
    vi.useFakeTimers();
    try {
      const start = vi.fn(
        async (): Promise<ConversationHandoffResult> => ({
          status: "failed",
          imported: 0,
          error: "import failed",
        }),
      );

      runCloudAgentHandoff("a13", start, undefined);
      // Resolve the start() promise + the .then arming the retry listener.
      await vi.advanceTimersByTimeAsync(0);
      expect(start).toHaveBeenCalledTimes(1);

      // Advance past the arm TTL: the listener self-detaches via AbortController.
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);

      // A (late) retry is now ignored — no second supervisor run, no leak.
      dispatchCloudHandoffRetry({ agentId: "a13" });
      await vi.advanceTimersByTimeAsync(0);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-fire the retry listener more than once per failure", async () => {
    const { stop } = collectPhases();
    const start = vi
      .fn<() => Promise<ConversationHandoffResult>>()
      .mockResolvedValue({ status: "switched", imported: 0 })
      .mockResolvedValueOnce({ status: "failed", imported: 0 });

    runCloudAgentHandoff("a4", start);
    await flush();

    // Two retry events in a row should only trigger one re-run (the listener
    // is one-shot; the second succeeds and arms nothing).
    dispatchCloudHandoffRetry({ agentId: "a4" });
    dispatchCloudHandoffRetry({ agentId: "a4" });
    await flush();
    stop();

    expect(start).toHaveBeenCalledTimes(2);
  });
});
