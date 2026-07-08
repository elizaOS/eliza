// Unit test for the VAD debug logger (voice V2a QA affordance). Verifies it is
// a genuine no-op when the env flag is off (owner ask: cheap-when-off), and
// logs with the [eliza][vad] prefix when on.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetVadDebugCacheForTests,
  isVadDebugEnabled,
  vadDebug,
} from "./vad-debug";

describe("vadDebug", () => {
  afterEach(() => {
    delete process.env.ELIZA_VAD_DEBUG;
    __resetVadDebugCacheForTests();
    vi.restoreAllMocks();
  });

  it("is a no-op when ELIZA_VAD_DEBUG is unset", () => {
    __resetVadDebugCacheForTests();
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    expect(isVadDebugEnabled()).toBe(false);
    vadDebug("auto-stop", { mode: "compose" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs with the [eliza][vad] prefix when enabled", () => {
    process.env.ELIZA_VAD_DEBUG = "1";
    __resetVadDebugCacheForTests();
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    expect(isVadDebugEnabled()).toBe(true);
    vadDebug("auto-send-suppressed", { reason: "too-few-words" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toContain("[eliza][vad] auto-send-suppressed");
    expect(spy.mock.calls[0]?.[1]).toEqual({ reason: "too-few-words" });
  });
});
