/**
 * Verifies the real finished-session TTL boundary with deterministic timers.
 * The service and module-level registry are real: only wall-clock scheduling is
 * faked so the test proves startup wiring, idle behavior, and eventual eviction.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessSession } from "../types/index.js";
import {
  addSession,
  getFinishedSession,
  markBackgrounded,
  markExited,
  resetProcessRegistryForTests,
} from "./processRegistry.js";
import { ShellService } from "./shellService.js";

function createSession(): ProcessSession {
  return {
    id: "ttl-boundary-session",
    command: "true",
    startedAt: Date.now(),
    maxOutputChars: 1_000,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: "",
    tail: "",
    exited: false,
    truncated: false,
    backgrounded: false,
  };
}

describe("finished-session TTL", () => {
  afterEach(() => {
    resetProcessRegistryForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("applies the startup TTL without starting an idle sweeper", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubEnv("SHELL_JOB_TTL_MS", "60000");

    const service = await ShellService.start({} as never);
    expect(vi.getTimerCount()).toBe(0);

    const session = createSession();
    addSession(session);
    markBackgrounded(session);
    markExited(session, 0, null, "completed");

    expect(vi.getTimerCount()).toBe(1);
    expect(getFinishedSession(session.id)).toBeDefined();

    await vi.advanceTimersByTimeAsync(89_999);
    expect(getFinishedSession(session.id)).toBeDefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(getFinishedSession(session.id)).toBeUndefined();

    await service.stop();
  });
});
