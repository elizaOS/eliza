import { describe, expect, mock, test } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { dispatchEvent } from "../../src/handlers/event";

function makeRuntime() {
  const emitEvent = mock(async () => {});
  return {
    runtime: { emitEvent } as unknown as IAgentRuntime,
    emitEvent,
  };
}

describe("dispatchEvent system events", () => {
  test("config-reload emits a runtime event and reports reload handled", async () => {
    const { runtime, emitEvent } = makeRuntime();
    const payload = { action: "config-reload", source: "gateway" };

    const result = await dispatchEvent(
      runtime,
      "agent-1",
      "user-1",
      "system",
      payload,
    );

    expect(result).toEqual({ reloaded: true });
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith("config-reload", {
      runtime,
      source: "agent-server",
      agentId: "agent-1",
      payload,
    });
  });

  test("health returns runtime status without emitting plugin events", async () => {
    const { runtime, emitEvent } = makeRuntime();

    const result = await dispatchEvent(runtime, "agent-1", "user-1", "system", {
      action: "health",
    });

    expect(result).toEqual({ status: "running", agentId: "agent-1" });
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
