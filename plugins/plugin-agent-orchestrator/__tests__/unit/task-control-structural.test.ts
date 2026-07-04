/**
 * Verifies TASKS:control structural action.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { taskControlAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

const controlOptions = { parameters: { action: "control" } };

describe("TASKS:control structural action", () => {
  it("does not infer stop from message text without controlAction", async () => {
    const svc = serviceMock();

    const result = await taskControlAction.handler(
      runtimeWith(svc),
      memory({ text: "let's stop using axios and switch to fetch" }),
      state,
      controlOptions,
      callback(),
    );

    expect(result?.success).toBe(false);
    expect(result?.text).toContain("No task-control action was specified");
    expect(svc.stopSession).not.toHaveBeenCalled();
  });

  it("does not infer resume from slang in message text", async () => {
    const svc = serviceMock();

    const result = await taskControlAction.handler(
      runtimeWith(svc),
      memory({ text: "make it so - do it, yeah i'm down" }),
      state,
      controlOptions,
      callback(),
    );

    expect(result?.success).toBe(false);
    expect(svc.sendToSession).not.toHaveBeenCalled();
  });

  it("still honors structured controlAction", async () => {
    const svc = serviceMock();

    const result = await taskControlAction.handler(
      runtimeWith(svc),
      memory({ text: "ordinary task text" }),
      state,
      {
        parameters: {
          action: "control",
          controlAction: "stop",
          sessionId: "abcdef123456",
        },
      },
      callback(),
    );

    expect(result?.success).toBe(true);
    expect(svc.stopSession).toHaveBeenCalledWith("abcdef123456");
  });
});
