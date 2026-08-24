import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildStoreVariantBlockedMessage: vi.fn((s: string) => `${s} unavailable`),
}));

vi.mock(
  "@elizaos/core",
  () => ({
    buildStoreVariantBlockedMessage: mocks.buildStoreVariantBlockedMessage,
  }),
  { virtual: true },
);

import { createTerminalUnsupportedTasksAction } from "./sandbox-stub.ts";

describe("createTerminalUnsupportedTasksAction", () => {
  it("builds an unavailable tasks action", async () => {
    const action = createTerminalUnsupportedTasksAction({
      message: "sandboxed",
      reason: "store build",
    });
    expect(action.name).toBe("TASKS");
    expect(action.suppressPostActionContinuation).toBe(true);
  });

  it("handler returns a user-facing error without spawning", async () => {
    const action = createTerminalUnsupportedTasksAction({
      message: "sandboxed",
      reason: "store build",
    });
    const callback = vi.fn();
    const result = await action.handler(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      callback as never,
    );
    expect(callback).toHaveBeenCalled();
    expect(result).toBeDefined();
  });
});
