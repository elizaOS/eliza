/**
 * Unit coverage for the conversation-handoff runner. Deps injected, no live cloud.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type ConversationHandoffDeps,
  type HandoffMessage,
  HandoffTransientError,
  isRetryableHandoffHttpStatus,
  isTransientHandoffError,
  runConversationHandoff,
  toHandoffMessages,
  waitForPersonalAgent,
} from "./conversation-handoff";

const SAMPLE: HandoffMessage[] = [
  { role: "user", text: "hello from shared", timestamp: 1 },
  { role: "assistant", text: "hi, shared eliza", timestamp: 2 },
];

function baseDeps(
  overrides: Partial<ConversationHandoffDeps> = {},
): ConversationHandoffDeps {
  return {
    checkPersonalReady: vi.fn(async () => ({
      ready: true,
      apiBase: "https://agent-1.elizacloud.ai",
    })),
    readSharedMessages: vi.fn(async () => SAMPLE),
    importToPersonal: vi.fn(async () => ({ inserted: SAMPLE.length })),
    switchToPersonal: vi.fn(),
    // Deterministic clock so timeouts don't hit the wall clock.
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("runConversationHandoff", () => {
  it("copies the shared conversation into the personal container then switches", async () => {
    const deps = baseDeps();
    const result = await runConversationHandoff(deps);

    expect(result).toEqual({ status: "switched", imported: 2 });
    expect(deps.readSharedMessages).toHaveBeenCalledTimes(1);
    expect(deps.importToPersonal).toHaveBeenCalledWith(SAMPLE, {
      ready: true,
      apiBase: "https://agent-1.elizacloud.ai",
    });
    // Switch happens AFTER the import, never before.
    const importOrder = (deps.importToPersonal as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const switchOrder = (deps.switchToPersonal as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(switchOrder).toBeGreaterThan(importOrder);
  });

  it("switches without importing when the shared conversation is empty", async () => {
    const deps = baseDeps({ readSharedMessages: vi.fn(async () => []) });
    const result = await runConversationHandoff(deps);

    expect(result).toEqual({ status: "switched-empty", imported: 0 });
    expect(deps.importToPersonal).not.toHaveBeenCalled();
    expect(deps.switchToPersonal).toHaveBeenCalledTimes(1);
  });

  it("never switches and reports timeout if the personal container never readies", async () => {
    const deps = baseDeps({
      checkPersonalReady: vi.fn(async () => ({ ready: false })),
      intervalMs: 10,
      timeoutMs: 25,
      // advance the clock deterministically: 0, 10, 20, 30 → exceeds 25
      now: (() => {
        let t = 0;
        return () => {
          const cur = t;
          t += 10;
          return cur;
        };
      })(),
    });

    const result = await runConversationHandoff(deps);
    expect(result.status).toBe("timed-out");
    expect(deps.readSharedMessages).not.toHaveBeenCalled();
    expect(deps.switchToPersonal).not.toHaveBeenCalled();
  });

  it("fails closed (no switch) when an I/O step throws", async () => {
    const deps = baseDeps({
      readSharedMessages: vi.fn(async () => {
        throw new Error("shared read 500");
      }),
    });
    const result = await runConversationHandoff(deps);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("shared read 500");
    expect(deps.switchToPersonal).not.toHaveBeenCalled();
  });

  it("treats an already-migrated personal conversation as success (idempotent)", async () => {
    const deps = baseDeps({
      importToPersonal: vi.fn(async () => ({
        inserted: 0,
        alreadyPopulated: true,
      })),
    });
    const result = await runConversationHandoff(deps);
    expect(result.status).toBe("switched");
    expect(result.imported).toBe(0);
    expect(deps.switchToPersonal).toHaveBeenCalledTimes(1);
  });

  // #15901: the control plane reports `running` minutes before the runtime
  // proxy routes to the container, so the import 404s during that window. The
  // orchestrator must spend its budget retrying, not hard-fail in seconds.
  it("retries a TRANSIENT import failure within the budget and still switches", async () => {
    let importCalls = 0;
    const deps = baseDeps({
      importToPersonal: vi.fn(async () => {
        importCalls += 1;
        if (importCalls < 3) {
          throw new HandoffTransientError(
            "conversation import failed (HTTP 404)",
          );
        }
        return { inserted: SAMPLE.length };
      }),
      intervalMs: 10,
      timeoutMs: 10_000,
      now: (() => {
        let t = 0;
        return () => {
          t += 10;
          return t;
        };
      })(),
    });

    const result = await runConversationHandoff(deps);
    expect(result).toEqual({ status: "switched", imported: 2 });
    expect(importCalls).toBe(3);
    expect(deps.switchToPersonal).toHaveBeenCalledTimes(1);
  });

  it("re-polls readiness between transient retries (base may still be warming)", async () => {
    let importCalls = 0;
    const deps = baseDeps({
      importToPersonal: vi.fn(async () => {
        importCalls += 1;
        if (importCalls === 1) {
          throw new HandoffTransientError(
            "conversation import failed (HTTP 404)",
          );
        }
        return { inserted: SAMPLE.length };
      }),
      intervalMs: 10,
      timeoutMs: 10_000,
      now: (() => {
        let t = 0;
        return () => {
          t += 10;
          return t;
        };
      })(),
    });

    await runConversationHandoff(deps);
    // Two attempts ⇒ two readiness resolutions: the retry goes back through
    // the readiness loop instead of blindly re-hitting a possibly-stale base.
    expect(deps.checkPersonalReady).toHaveBeenCalledTimes(2);
  });

  it("a NON-transient step failure still fails immediately (no retry burn)", async () => {
    const deps = baseDeps({
      importToPersonal: vi.fn(async () => {
        throw new Error("conversation import failed (HTTP 401)");
      }),
      intervalMs: 10,
      timeoutMs: 10_000,
    });
    const result = await runConversationHandoff(deps);
    expect(result.status).toBe("failed");
    expect(deps.importToPersonal).toHaveBeenCalledTimes(1);
    expect(deps.switchToPersonal).not.toHaveBeenCalled();
  });

  it("exhausting the budget on transient failures fails with the last error, never a fabricated success", async () => {
    const deps = baseDeps({
      importToPersonal: vi.fn(async () => {
        throw new HandoffTransientError(
          "conversation import failed (HTTP 404)",
        );
      }),
      intervalMs: 10,
      timeoutMs: 35,
      now: (() => {
        let t = 0;
        return () => {
          const cur = t;
          t += 10;
          return cur;
        };
      })(),
    });
    const result = await runConversationHandoff(deps);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("HTTP 404");
    expect(deps.switchToPersonal).not.toHaveBeenCalled();
  });

  it("transient retries share ONE deadline — a step failure never re-arms a fresh budget", async () => {
    // Clock: each now() call advances 10. With timeoutMs 40 the deadline is
    // fixed at the first read; the readiness re-poll after a transient failure
    // gets only the REMAINING budget, so the run ends within ~the original
    // window instead of timeoutMs-per-attempt.
    let nowCalls = 0;
    const deps = baseDeps({
      checkPersonalReady: vi.fn(async () => ({ ready: true })),
      importToPersonal: vi.fn(async () => {
        throw new HandoffTransientError(
          "conversation import failed (HTTP 503)",
        );
      }),
      intervalMs: 10,
      timeoutMs: 40,
      now: () => {
        nowCalls += 1;
        return nowCalls * 10;
      },
    });
    const result = await runConversationHandoff(deps);
    expect(result.status).toBe("failed");
    // Bounded attempts (not infinite, not one): the shared deadline capped it.
    const attempts = (deps.importToPersonal as ReturnType<typeof vi.fn>).mock
      .calls.length;
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThan(6);
  });
});

describe("transient-error classification", () => {
  it("flags HandoffTransientError and duck-typed transient errors", () => {
    expect(isTransientHandoffError(new HandoffTransientError("x"))).toBe(true);
    expect(isTransientHandoffError({ transient: true })).toBe(true);
    expect(isTransientHandoffError(new Error("x"))).toBe(false);
    expect(isTransientHandoffError(null)).toBe(false);
  });

  it("retryable statuses cover the proxy-readiness window and transient upstream failures only", () => {
    for (const status of [404, 408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryableHandoffHttpStatus(status)).toBe(true);
    }
    for (const status of [200, 201, 400, 401, 403, 409, 422]) {
      expect(isRetryableHandoffHttpStatus(status)).toBe(false);
    }
  });
});

describe("waitForPersonalAgent", () => {
  it("returns once the container reports ready", async () => {
    let calls = 0;
    const readiness = await waitForPersonalAgent({
      checkPersonalReady: async () => {
        calls += 1;
        return calls >= 3
          ? { ready: true, apiBase: "https://x.elizacloud.ai" }
          : { ready: false };
      },
      intervalMs: 1,
      timeoutMs: 1_000,
      sleep: async () => {},
      now: () => 0,
    });
    expect(readiness.ready).toBe(true);
    expect(calls).toBe(3);
  });

  it("a thrown readiness check is treated as not-ready (keeps polling)", async () => {
    let calls = 0;
    const readiness = await waitForPersonalAgent({
      checkPersonalReady: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return { ready: true };
      },
      intervalMs: 1,
      timeoutMs: 1_000,
      sleep: async () => {},
      now: () => 0,
    });
    expect(readiness.ready).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("toHandoffMessages", () => {
  it("keeps valid user/assistant messages in order, drops junk", () => {
    const out = toHandoffMessages([
      { role: "user", text: " hi ", timestamp: 5 },
      { role: "assistant", text: "" }, // empty → dropped
      { role: "system", text: "nope" }, // bad role → dropped
      { role: "assistant", text: "yo", timestamp: 7 },
      { text: "no role" }, // → dropped
    ]);
    expect(out).toEqual([
      { role: "user", text: "hi", timestamp: 5 },
      { role: "assistant", text: "yo", timestamp: 7 },
    ]);
  });
});
