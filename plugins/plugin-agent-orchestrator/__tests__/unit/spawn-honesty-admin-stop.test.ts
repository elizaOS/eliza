/**
 * Verifies the spawn-honesty and admin-stop-stamp lane on the TASKS runners:
 * create-path respawn-ack suppression (router-stamped synthetic inbounds get
 * planner-only text and claim the request-voice ack), spawnRootMessageId
 * persistence into session and durable-task metadata, and the adminStopReason
 * stamp landing BEFORE every administrative stop/cancel — while the one-shot
 * prompt teardown stays unmarked (#11689 never-silent-terminal invariant).
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import type { State } from "@elizaos/core";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  cancelTaskAction,
  createTaskAction,
  stopAgentAction,
  taskControlAction,
} from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
} from "../../src/test-utils/action-test-utils.js";

const createOptions = { parameters: { action: "create" } };

// These pins exercise ack routing on the direct-prompt path. Under the
// default Smithers path a create without a durable task owner fails closed
// (covered by the widget-emission suite).
let previousSmithers: string | undefined;
beforeEach(() => {
  previousSmithers = process.env.ELIZA_ORCHESTRATOR_SMITHERS;
  process.env.ELIZA_ORCHESTRATOR_SMITHERS = "0";
});
afterEach(() => {
  if (previousSmithers === undefined) {
    delete process.env.ELIZA_ORCHESTRATOR_SMITHERS;
  } else {
    process.env.ELIZA_ORCHESTRATOR_SMITHERS = previousSmithers;
  }
});
const freshState = () => ({}) as State;

function runtimeRouting(
  svc: unknown,
  services: Record<string, unknown>,
): ReturnType<typeof runtimeWith> {
  const runtime = runtimeWith(svc);
  (runtime.getService as ReturnType<typeof vi.fn>).mockImplementation(
    (type: string) => (type in services ? services[type] : svc),
  );
  return runtime;
}

describe("TASKS:create respawn-ack suppression", () => {
  it("fresh user create still posts the visible creation ack", async () => {
    const svc = serviceMock();
    const cb = callback();
    const result = await createTaskAction.handler(
      runtimeWith(svc),
      memory({ task: "build a landing page" }),
      freshState(),
      createOptions,
      cb,
    );
    expect(result?.success).toBe(true);
    expect(cb).toHaveBeenCalled();
    const delivered = cb.mock.calls[0]?.[0] as { text?: string };
    expect(delivered.text).toContain("On it");
    expect(result?.userFacingText).toContain("On it");
    expect(result?.turnComplete).toBe(true);
  });

  it("synthetic respawn inbound suppresses the ack and claims the request-voice slot", async () => {
    const svc = serviceMock();
    const router = { claimRequestAck: vi.fn() };
    const cb = callback();
    const result = await createTaskAction.handler(
      runtimeRouting(svc, { ACPX_SUB_AGENT_ROUTER: router }),
      memory({
        task: "continue the failed landing page build",
        source: "sub_agent",
        metadata: { subAgent: true, spawnRootMessageId: "root-9" },
      }),
      freshState(),
      createOptions,
      cb,
    );
    expect(result?.success).toBe(true);
    // Planner-only result: no visible callback, no verified user-facing text.
    expect(cb).not.toHaveBeenCalled();
    expect(result?.userFacingText).toBeUndefined();
    expect(result?.turnComplete).toBeUndefined();
    expect(router.claimRequestAck).toHaveBeenCalledWith(
      "root-9",
      "abcdef123456",
    );
  });

  it("fails open when the router lacks the claimRequestAck API", async () => {
    const svc = serviceMock();
    const result = await createTaskAction.handler(
      runtimeRouting(svc, { ACPX_SUB_AGENT_ROUTER: {} }),
      memory({
        task: "continue the failed build",
        source: "sub_agent",
        metadata: { subAgent: true },
      }),
      freshState(),
      createOptions,
      callback(),
    );
    expect(result?.success).toBe(true);
  });
});

describe("TASKS:create spawnRootMessageId persistence", () => {
  it("stamps the root id into the create-path session metadata", async () => {
    const svc = serviceMock();
    await createTaskAction.handler(
      runtimeWith(svc),
      memory({ task: "build a landing page" }),
      freshState(),
      createOptions,
      callback(),
    );
    const call = svc.spawnSession.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown>;
    };
    // No connector id on the memory → the root id falls back to message.id.
    expect(call.metadata?.spawnRootMessageId).toBe("msg1");
  });

  it("stamps the root id into the create-path durable task metadata", async () => {
    const svc = serviceMock();
    const tasks = {
      createTask: vi.fn(async () => ({ id: "durable-task-1" })),
      attachSession: vi.fn(async () => true),
    };
    await createTaskAction.handler(
      runtimeRouting(svc, { ORCHESTRATOR_TASK_SERVICE: tasks }),
      memory({ task: "build a landing page" }),
      freshState(),
      createOptions,
      callback(),
    );
    expect(tasks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ spawnRootMessageId: "msg1" }),
      }),
    );
  });
});

describe("administrative stop stamps land before the stop", () => {
  function recordingService(order: string[]) {
    return serviceMock({
      updateSessionMetadata: vi.fn(
        async (sid: string, patch: Record<string, unknown>) => {
          if ("adminStopReason" in patch) {
            order.push(`stamp:${sid}:${String(patch.adminStopReason)}`);
          }
        },
      ),
      stopSession: vi.fn(async (sid: string) => {
        order.push(`stop:${sid}`);
      }),
      cancelSession: vi.fn(async (sid: string) => {
        order.push(`cancel:${sid}`);
      }),
    });
  }

  it("stop_agent (single) stamps user_stop before stopping", async () => {
    const order: string[] = [];
    const svc = recordingService(order);
    const result = await stopAgentAction.handler(
      runtimeWith(svc),
      memory({}),
      freshState(),
      { parameters: { action: "stop_agent" } },
      callback(),
    );
    expect(result?.success).toBe(true);
    expect(order).toEqual([
      "stamp:abcdef123456:user_stop",
      "stop:abcdef123456",
    ]);
  });

  it("stop_agent (all) stamps every session before stopping it", async () => {
    const order: string[] = [];
    const svc = recordingService(order);
    const result = await stopAgentAction.handler(
      runtimeWith(svc),
      memory({}),
      freshState(),
      { parameters: { action: "stop_agent", all: true } },
      callback(),
    );
    expect(result?.success).toBe(true);
    expect(order).toEqual([
      "stamp:abcdef123456:user_stop",
      "stop:abcdef123456",
    ]);
  });

  it("cancel (single) stamps user_cancel before cancelling", async () => {
    const order: string[] = [];
    const svc = recordingService(order);
    const result = await cancelTaskAction.handler(
      runtimeWith(svc),
      memory({}),
      freshState(),
      { parameters: { action: "cancel" } },
      callback(),
    );
    expect(result?.success).toBe(true);
    expect(order).toEqual([
      "stamp:abcdef123456:user_cancel",
      "cancel:abcdef123456",
    ]);
  });

  it("cancel (all) stamps user_cancel before each cancel", async () => {
    const order: string[] = [];
    const svc = recordingService(order);
    const result = await cancelTaskAction.handler(
      runtimeWith(svc),
      memory({}),
      freshState(),
      { parameters: { action: "cancel", all: true } },
      callback(),
    );
    expect(result?.success).toBe(true);
    expect(order).toEqual([
      "stamp:abcdef123456:user_cancel",
      "cancel:abcdef123456",
    ]);
  });

  it("control stop stamps user_stop before stopping", async () => {
    const order: string[] = [];
    const svc = recordingService(order);
    const result = await taskControlAction.handler(
      runtimeWith(svc),
      memory({}),
      freshState(),
      { parameters: { action: "control", controlAction: "stop" } },
      callback(),
    );
    expect(result?.success).toBe(true);
    expect(order).toEqual([
      "stamp:abcdef123456:user_stop",
      "stop:abcdef123456",
    ]);
  });

  it("one-shot prompt teardown does NOT stamp adminStopReason", async () => {
    const order: string[] = [];
    const svc = recordingService(order);
    const result = await createTaskAction.handler(
      runtimeWith(svc),
      memory({ task: "build a landing page" }),
      freshState(),
      createOptions,
      callback(),
    );
    expect(result?.success).toBe(true);
    // The runPromptAndClose teardown stop fired, but unmarked: a teardown stop
    // after a successful terminal event is already suppressed deterministically
    // by routerCededTerminalSessions, and crash stops must keep synthesizing.
    expect(order).toEqual(["stop:abcdef123456"]);
  });
});
