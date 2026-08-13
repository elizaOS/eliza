/** Verifies hosted runtime stop/close deadlines use strict, timer-safe overrides. */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { elizaLogger } from "@elizaos/core";
import { runWithLifecycleTimeout } from "./lifecycle";

const originalTimeout = process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;

afterEach(() => {
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
  if (originalTimeout === undefined) {
    delete process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS;
  } else {
    process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS = originalTimeout;
  }
});

function captureScheduledDelay(value: string | undefined): {
  delay: number;
  cleared: boolean;
  fire: () => void;
} {
  if (value === undefined) {
    delete process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS;
  } else {
    process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS = value;
  }

  let scheduledDelay: number | undefined;
  let scheduledCallback: (() => void) | undefined;
  let cleared = false;
  const handle = { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
    scheduledDelay = delay;
    scheduledCallback = () => callback();
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    if (timer === handle) cleared = true;
  }) as typeof clearTimeout;

  return {
    get delay() {
      if (scheduledDelay === undefined) throw new Error("timeout was not scheduled");
      return scheduledDelay;
    },
    get cleared() {
      return cleared;
    },
    fire() {
      if (!scheduledCallback) throw new Error("timeout was not scheduled");
      scheduledCallback();
    },
  };
}

describe("runWithLifecycleTimeout", () => {
  test.each([
    ["1", 1],
    [" 25 ", 25],
    ["10000", 10_000],
    ["2147483647", 2_147_483_647],
  ])("uses timer-safe positive integer override %s", async (value, expected) => {
    const observation = captureScheduledDelay(value);
    await runWithLifecycleTimeout(Promise.resolve(), "Stop", "RuntimeCache", "agent-1");

    expect(observation.delay).toBe(expected);
    expect(observation.cleared).toBe(true);
  });

  test.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["zero", "0"],
    ["negative", "-1"],
    ["signed", "+1"],
    ["fractional", "1.5"],
    ["scientific", "1e3"],
    ["suffix", "25ms"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["timer overflow", "2147483648"],
    ["unsafe integer", "9007199254740992"],
  ])("uses the default for invalid override: %s", async (_label, value) => {
    const observation = captureScheduledDelay(value);
    await runWithLifecycleTimeout(Promise.resolve(), "Close", "DbAdapterPool", "agent-2");

    expect(observation.delay).toBe(10_000);
    expect(observation.cleared).toBe(true);
  });

  test("bounds a never-settling operation and logs the exact configured deadline", async () => {
    process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS = "10";
    const warning = spyOn(elizaLogger, "warn").mockImplementation(() => {});

    try {
      await runWithLifecycleTimeout(
        new Promise<void>(() => {}),
        "Stop",
        "RuntimeCache",
        "agent-timeout",
      );

      expect(warning).toHaveBeenCalledWith(
        "[RuntimeCache] Stop timed out after 10ms for agent-timeout",
      );
    } finally {
      warning.mockRestore();
    }
  });

  test.each(["5ms", "2147483648"])(
    "does not fire at the permissively parsed prefix for invalid override %s",
    async (value) => {
      process.env.RUNTIME_LIFECYCLE_TIMEOUT_MS = value;
      let resolveOperation: (() => void) | undefined;
      let lifecycleSettled = false;
      const operation = new Promise<void>((resolve) => {
        resolveOperation = resolve;
      });
      const lifecycle = runWithLifecycleTimeout(
        operation,
        "Close",
        "DbAdapterPool",
        "agent-real-timer",
      ).then(() => {
        lifecycleSettled = true;
      });

      await new Promise<void>((resolve) => nativeSetTimeout(resolve, 50));
      expect(lifecycleSettled).toBe(false);
      resolveOperation?.();
      await lifecycle;
    },
  );
});
