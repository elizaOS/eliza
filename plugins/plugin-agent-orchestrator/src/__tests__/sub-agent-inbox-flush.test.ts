/**
 * Verifies queued sub-agent input is driven by ACP lifecycle events, including
 * coalesced ready events and teardown, without clocks or polling.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SubAgentInbox } from "../services/sub-agent-inbox.js";
import { SubAgentInboxFlush } from "../services/sub-agent-inbox-flush.js";
import type { SessionEventCallback, SessionInfo } from "../services/types.js";

const SESSION_ID = "session-1";

function session(status: string): SessionInfo {
  return {
    id: SESSION_ID,
    name: SESSION_ID,
    agentType: "codex",
    workdir: "/tmp/inbox-flush",
    status,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
  };
}

function runtime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    reportError: vi.fn(),
  } as never;
}

function harness(initialStatus = "ready") {
  const inbox = new SubAgentInbox();
  let current = session(initialStatus);
  let callback: SessionEventCallback | undefined;
  const sendPrompt = vi.fn(async () => ({
    sessionId: SESSION_ID,
    response: "done",
    stopReason: "end_turn",
    durationMs: 1,
    exitCode: 0,
    signal: null,
  }));
  const acp = {
    getSession: vi.fn(async () => current),
    sendPrompt,
    onSessionEvent: vi.fn((next: SessionEventCallback) => {
      callback = next;
      return () => {
        callback = undefined;
      };
    }),
  };
  const flush = new SubAgentInboxFlush(runtime(), acp as never, inbox);
  flush.start();
  return {
    acp,
    flush,
    inbox,
    sendPrompt,
    emit(event: string) {
      callback?.(SESSION_ID, event, {});
    },
    setStatus(status: string) {
      current = { ...current, status };
    },
  };
}

describe("SubAgentInboxFlush", () => {
  it("waits for ready instead of reacting to task_complete or polling", async () => {
    const test = harness("busy");
    test.inbox.enqueue(SESSION_ID, "queued while busy");

    test.emit("task_complete");
    await Promise.resolve();
    expect(test.acp.getSession).not.toHaveBeenCalled();
    expect(test.sendPrompt).not.toHaveBeenCalled();

    test.setStatus("ready");
    test.emit("ready");
    await vi.waitFor(() =>
      expect(test.sendPrompt).toHaveBeenCalledWith(
        SESSION_ID,
        "queued while busy",
      ),
    );
  });

  it("consumes a ready event emitted during an active flush", async () => {
    const test = harness();
    test.inbox.enqueue(SESSION_ID, "first");
    test.sendPrompt.mockImplementation(async (_sessionId, text) => {
      if (text === "first") {
        test.inbox.enqueue(SESSION_ID, "second");
        test.emit("ready");
      }
      return {
        sessionId: SESSION_ID,
        response: "done",
        stopReason: "end_turn",
        durationMs: 1,
        exitCode: 0,
        signal: null,
      };
    });

    test.emit("ready");
    await vi.waitFor(() => expect(test.sendPrompt).toHaveBeenCalledTimes(2));

    expect(test.sendPrompt.mock.calls).toEqual([
      [SESSION_ID, "first"],
      [SESSION_ID, "second"],
    ]);
  });

  it("requeues a failed delivery and retries only on the next ready event", async () => {
    const test = harness();
    test.inbox.enqueue(SESSION_ID, "do not lose me");
    test.sendPrompt.mockRejectedValueOnce(new Error("transport failed"));

    test.emit("ready");
    await vi.waitFor(() => expect(test.sendPrompt).toHaveBeenCalledTimes(1));
    await test.flush.drain();
    expect(test.inbox.size(SESSION_ID)).toBe(1);

    test.emit("ready");
    await vi.waitFor(() => expect(test.sendPrompt).toHaveBeenCalledTimes(2));
    expect(test.inbox.size(SESSION_ID)).toBe(0);
  });

  it("detaches and drains active work without requeueing during teardown", async () => {
    const test = harness();
    test.inbox.enqueue(SESSION_ID, "active");
    let rejectPrompt: ((reason: unknown) => void) | undefined;
    test.sendPrompt.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectPrompt = reject;
        }),
    );

    test.emit("ready");
    await vi.waitFor(() => expect(rejectPrompt).toBeDefined());
    test.flush.detach();
    rejectPrompt?.(new DOMException("service stopped", "AbortError"));
    await test.flush.drain();

    expect(test.inbox.size(SESSION_ID)).toBe(0);
    test.emit("ready");
    expect(test.sendPrompt).toHaveBeenCalledTimes(1);
  });
});
