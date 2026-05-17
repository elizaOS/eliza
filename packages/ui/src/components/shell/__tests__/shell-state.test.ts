import { describe, expect, it } from "vitest";
import {
  initialShellState,
  type ShellAction,
  type ShellState,
  shellReducer,
} from "../shell-state";

function reduce(state: ShellState, actions: ShellAction[]): ShellState {
  return actions.reduce(shellReducer, state);
}

describe("shellReducer", () => {
  it("starts in the booting phase with an empty conversation", () => {
    expect(initialShellState.phase).toBe("booting");
    expect(initialShellState.messages).toEqual([]);
    expect(initialShellState.isOnline).toBe(true);
  });

  it("BOOT_READY transitions booting -> idle", () => {
    const next = shellReducer(initialShellState, { type: "BOOT_READY" });
    expect(next.phase).toBe("idle");
  });

  it("BOOT_READY is a no-op when not booting", () => {
    const start: ShellState = { ...initialShellState, phase: "idle" };
    const next = shellReducer(start, { type: "BOOT_READY" });
    expect(next).toBe(start);
  });

  it("OPEN moves idle -> summoned, CLOSE moves summoned -> idle", () => {
    const idle = reduce(initialShellState, [{ type: "BOOT_READY" }]);
    const opened = shellReducer(idle, { type: "OPEN" });
    expect(opened.phase).toBe("summoned");
    const closed = shellReducer(opened, { type: "CLOSE" });
    expect(closed.phase).toBe("idle");
  });

  it("SEND moves summoned -> responding and appends user + assistant placeholder messages", () => {
    const summoned = reduce(initialShellState, [
      { type: "BOOT_READY" },
      { type: "OPEN" },
    ]);
    const next = shellReducer(summoned, { type: "SEND", text: "hello" });
    expect(next.phase).toBe("responding");
    expect(next.messages).toHaveLength(2);
    expect(next.messages[0]).toEqual(
      expect.objectContaining({ role: "user", content: "hello" }),
    );
    expect(next.messages[1]).toEqual(
      expect.objectContaining({ role: "assistant", content: "" }),
    );
  });

  it("RESPONSE_DELTA appends to the latest assistant message", () => {
    const responding = reduce(initialShellState, [
      { type: "BOOT_READY" },
      { type: "OPEN" },
      { type: "SEND", text: "hi" },
    ]);
    const first = shellReducer(responding, {
      type: "RESPONSE_DELTA",
      delta: "Hi",
    });
    const second = shellReducer(first, {
      type: "RESPONSE_DELTA",
      delta: " there",
    });
    const last = second.messages[second.messages.length - 1];
    expect(last).toEqual(
      expect.objectContaining({ role: "assistant", content: "Hi there" }),
    );
  });

  it("RESPONSE_DONE moves responding -> summoned", () => {
    const responding = reduce(initialShellState, [
      { type: "BOOT_READY" },
      { type: "OPEN" },
      { type: "SEND", text: "hi" },
    ]);
    const next = shellReducer(responding, { type: "RESPONSE_DONE" });
    expect(next.phase).toBe("summoned");
  });

  it("RESPONSE_DONE clears any prior lastError", () => {
    // Simulate: send -> error -> send again -> done. After the second
    // success, the stale error from the first round must be gone.
    const afterError = reduce(initialShellState, [
      { type: "BOOT_READY" },
      { type: "OPEN" },
      { type: "SEND", text: "first" },
      { type: "RESPONSE_ERROR", error: "boom" },
    ]);
    expect(afterError.lastError).toBe("boom");
    const afterDone = reduce(afterError, [
      { type: "SEND", text: "second" },
      { type: "RESPONSE_DONE" },
    ]);
    expect(afterDone.lastError).toBeNull();
    expect(afterDone.phase).toBe("summoned");
  });

  it("RESPONSE_ERROR moves responding -> summoned and records the error", () => {
    const responding = reduce(initialShellState, [
      { type: "BOOT_READY" },
      { type: "OPEN" },
      { type: "SEND", text: "hi" },
    ]);
    const next = shellReducer(responding, {
      type: "RESPONSE_ERROR",
      error: "boom",
    });
    expect(next.phase).toBe("summoned");
    expect(next.lastError).toBe("boom");
  });

  it("NETWORK updates isOnline without changing phase", () => {
    const idle = reduce(initialShellState, [{ type: "BOOT_READY" }]);
    const offline = shellReducer(idle, { type: "NETWORK", isOnline: false });
    expect(offline.isOnline).toBe(false);
    expect(offline.phase).toBe("idle");
  });

  it("invalid transitions are no-ops (return the same state reference)", () => {
    const booting = initialShellState;
    const result = shellReducer(booting, { type: "OPEN" });
    expect(result).toBe(booting);
  });

  it("SEND from responding is a no-op (reducer refuses, callers must gate)", () => {
    // Final code review caught: App.tsx had canSend include "responding",
    // but the reducer only accepts SEND from summoned/listening. This test
    // pins the reducer contract so a future regression is caught at unit level.
    const responding = reduce(initialShellState, [
      { type: "BOOT_READY" },
      { type: "OPEN" },
      { type: "SEND", text: "hi" },
    ]);
    expect(responding.phase).toBe("responding");
    const stillResponding = shellReducer(responding, {
      type: "SEND",
      text: "second",
    });
    expect(stillResponding).toBe(responding);
  });

  it("CLOSE works from summoned, listening, and responding", () => {
    const summoned = reduce(initialShellState, [
      { type: "BOOT_READY" },
      { type: "OPEN" },
    ]);
    expect(shellReducer(summoned, { type: "CLOSE" }).phase).toBe("idle");

    // listening state isn't reachable yet (no transition into it in v1),
    // but the reducer should still allow CLOSE if some other action set it.
    const listening = { ...summoned, phase: "listening" as const };
    expect(shellReducer(listening, { type: "CLOSE" }).phase).toBe("idle");

    const responding = reduce(initialShellState, [
      { type: "BOOT_READY" },
      { type: "OPEN" },
      { type: "SEND", text: "hi" },
    ]);
    expect(responding.phase).toBe("responding");
    expect(shellReducer(responding, { type: "CLOSE" }).phase).toBe("idle");
  });
});
