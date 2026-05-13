/**
 * L6 — event-driven cancellation tests for `cancelToSignal` in
 * `pipeline-impls.ts`. The function is module-internal; we exercise it
 * through `LlamaServerDraftProposer.propose`, which is the only public
 * caller. The `DflashTextRunner` stub records the `AbortSignal` it
 * received so we can assert it aborts synchronously on `onCancel()`.
 */

import { describe, expect, it } from "vitest";
import {
  type CancelTokenWithSignal,
  type DflashTextRunner,
  LlamaServerDraftProposer,
} from "./pipeline-impls";
import type { VerifierStreamEvent } from "./types";

function runnerCapturingSignal(): DflashTextRunner & {
  capturedSignal: AbortSignal | null;
  resolveDone: () => void;
} {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const r = {
    capturedSignal: null as AbortSignal | null,
    resolveDone,
    hasDrafter: () => true,
    async generateWithVerifierEvents(args: {
      signal?: AbortSignal;
      onVerifierEvent?: (event: VerifierStreamEvent) => void | Promise<void>;
    }) {
      r.capturedSignal = args.signal ?? null;
      // Block until the test releases us so we can assert the signal
      // aborts during the call.
      await done;
      return { text: "" };
    },
  };
  return r;
}

describe("L6 cancelToSignal — event-driven cancellation", () => {
  it("aborts the AbortSignal synchronously when the cancel token's onCancel fires", async () => {
    const runner = runnerCapturingSignal();
    const proposer = new LlamaServerDraftProposer(runner);
    const listeners = new Set<() => void>();
    const token: CancelTokenWithSignal = {
      cancelled: false,
      onCancel: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const promise = proposer.propose({
      prefix: [{ index: 0, text: "hi" }],
      maxDraft: 4,
      cancel: token,
    });
    // Yield once so the runner captures the signal.
    await new Promise((r) => setTimeout(r, 0));
    expect(runner.capturedSignal).not.toBeNull();
    expect(runner.capturedSignal?.aborted).toBe(false);
    // Trip the cancellation — the listener registered via onCancel must
    // synchronously abort the captured signal.
    token.cancelled = true;
    for (const l of listeners) l();
    expect(runner.capturedSignal?.aborted).toBe(true);
    runner.resolveDone();
    await promise;
  });

  it("aborts immediately when the cancel token is already cancelled before the call", async () => {
    const runner = runnerCapturingSignal();
    const proposer = new LlamaServerDraftProposer(runner);
    const token: CancelTokenWithSignal = {
      cancelled: true,
      onCancel: () => () => {},
    };
    // Already-cancelled tokens short-circuit in propose() before the
    // runner is even invoked.
    const result = await proposer.propose({
      prefix: [],
      maxDraft: 4,
      cancel: token,
    });
    expect(result).toEqual([]);
    expect(runner.capturedSignal).toBeNull();
    runner.resolveDone();
  });

  it("falls back to polling when the token has no onCancel hook", async () => {
    const runner = runnerCapturingSignal();
    const proposer = new LlamaServerDraftProposer(runner);
    const token: CancelTokenWithSignal = { cancelled: false };
    const promise = proposer.propose({
      prefix: [{ index: 0, text: "hi" }],
      maxDraft: 4,
      cancel: token,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(runner.capturedSignal?.aborted).toBe(false);
    token.cancelled = true;
    // The poll fires within ~10 ms; give it 50 ms of headroom.
    await new Promise((r) => setTimeout(r, 50));
    expect(runner.capturedSignal?.aborted).toBe(true);
    runner.resolveDone();
    await promise;
  });
});
