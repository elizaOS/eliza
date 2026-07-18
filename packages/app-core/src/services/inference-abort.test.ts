/**
 * Pins the deprecation contract from #16470: this registry is superseded by
 * `@elizaos/core`'s runtime-owned `abortInflightInference` and is inert in
 * production (nothing calls `trackInflight`), so `abortInflightInference`
 * here must keep reporting `{aborted: 0}` for untracked runtimes, and the
 * mechanics must stay intact for any straggler external caller until the
 * deprecated module is removed in the next major.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  __resetInflightInferenceForTests,
  abortInflightInference,
  getInflightInferenceCount,
  trackInflight,
} from "./inference-abort";

function makeRuntime(): IAgentRuntime {
  return { agentId: "test-agent" } as unknown as IAgentRuntime;
}

describe("inference-abort (deprecated registry, #16470)", () => {
  it("reports {aborted: 0} for a runtime nothing registered into — the production reality", () => {
    const runtime = makeRuntime();
    expect(abortInflightInference(runtime)).toEqual({ aborted: 0 });
    expect(getInflightInferenceCount(runtime)).toBe(0);
  });

  it("aborts and clears tracked controllers, and disposers deregister completed calls", () => {
    const runtime = makeRuntime();
    const a = new AbortController();
    const b = new AbortController();
    const disposeA = trackInflight(runtime, a);
    trackInflight(runtime, b);
    expect(getInflightInferenceCount(runtime)).toBe(2);

    // A completed call disposes itself and must not be aborted later.
    disposeA();
    expect(getInflightInferenceCount(runtime)).toBe(1);

    expect(abortInflightInference(runtime)).toEqual({ aborted: 1 });
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(true);
    // Idempotent: the set was cleared.
    expect(abortInflightInference(runtime)).toEqual({ aborted: 0 });

    __resetInflightInferenceForTests(runtime);
    expect(getInflightInferenceCount(runtime)).toBe(0);
  });

  it("keys per runtime — one runtime's abort never touches another's controllers", () => {
    const r1 = makeRuntime();
    const r2 = makeRuntime();
    const c1 = new AbortController();
    const c2 = new AbortController();
    trackInflight(r1, c1);
    trackInflight(r2, c2);

    expect(abortInflightInference(r1)).toEqual({ aborted: 1 });
    expect(c2.signal.aborted).toBe(false);
    expect(getInflightInferenceCount(r2)).toBe(1);
    __resetInflightInferenceForTests(r2);
  });
});
