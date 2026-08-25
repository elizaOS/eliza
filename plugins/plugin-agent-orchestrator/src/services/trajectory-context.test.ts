import { describe, expect, it, vi } from "vitest";
import {
  clearTrajectoryContext,
  setTrajectoryContext,
  withTrajectoryContext,
} from "./trajectory-context";

const CTX_KEY = "__orchestratorTrajectoryCtx";

describe("trajectory-context", () => {
  it("sets the context on the runtime object", () => {
    const runtime = {};
    const ctx = {
      source: "orchestrator" as const,
      decisionType: "skill-context-generation" as const,
      sessionId: "sess-1",
    };
    setTrajectoryContext(runtime, ctx);
    expect((runtime as Record<string, unknown>)[CTX_KEY]).toBe(ctx);
  });

  it("clears the context to undefined", () => {
    const runtime = { [CTX_KEY]: { source: "orchestrator" } };
    clearTrajectoryContext(runtime);
    expect((runtime as Record<string, unknown>)[CTX_KEY]).toBeUndefined();
  });

  it("sets context before the wrapped call and clears it after", async () => {
    const runtime = {};
    const ctx = {
      source: "orchestrator" as const,
      decisionType: "launch-failure-message" as const,
    };
    let seenDuringCall: unknown;
    const result = await withTrajectoryContext(runtime, ctx, async () => {
      seenDuringCall = (runtime as Record<string, unknown>)[CTX_KEY];
      return 42;
    });
    expect(seenDuringCall).toBe(ctx);
    expect(result).toBe(42);
    expect((runtime as Record<string, unknown>)[CTX_KEY]).toBeUndefined();
  });

  it("clears the context even when the wrapped call throws", async () => {
    const runtime = {};
    const ctx = {
      source: "orchestrator" as const,
      decisionType: "skill-context-generation" as const,
    };
    await expect(
      withTrajectoryContext(runtime, ctx, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The finally block must prevent a leaked context from tagging
    // unrelated follow-up LLM calls.
    expect((runtime as Record<string, unknown>)[CTX_KEY]).toBeUndefined();
  });

  it("clears the context when the wrapped call rejects", async () => {
    const runtime = {};
    await expect(
      withTrajectoryContext(
        runtime,
        { source: "orchestrator", decisionType: "launch-failure-message" },
        async () => Promise.reject(new Error("rejected")),
      ),
    ).rejects.toThrow("rejected");
    expect((runtime as Record<string, unknown>)[CTX_KEY]).toBeUndefined();
  });

  it("preserves task metadata in the stored context", () => {
    const runtime = {};
    const ctx = {
      source: "orchestrator" as const,
      decisionType: "skill-context-generation" as const,
      sessionId: "sess-9",
      taskLabel: "fix login",
      repo: "acme/app",
    };
    setTrajectoryContext(runtime, ctx);
    const stored = (runtime as Record<string, unknown>)[CTX_KEY] as {
      sessionId?: string;
      taskLabel?: string;
      repo?: string;
    };
    expect(stored.sessionId).toBe("sess-9");
    expect(stored.taskLabel).toBe("fix login");
    expect(stored.repo).toBe("acme/app");
  });

  it("does not require a promise-returning call", async () => {
    const runtime = {};
    const fn = vi.fn(() => Promise.resolve("ok"));
    await withTrajectoryContext(
      runtime,
      { source: "orchestrator", decisionType: "launch-failure-message" },
      fn,
    );
    expect(fn).toHaveBeenCalledOnce();
    expect((runtime as Record<string, unknown>)[CTX_KEY]).toBeUndefined();
  });
});
