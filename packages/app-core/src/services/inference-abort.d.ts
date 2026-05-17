/**
 * Per-runtime in-flight inference AbortController registry.
 *
 * Wave 3C's `useAppLifecycleEvents` hook (`packages/ui/src/state/
 * useAppLifecycleEvents.ts`) fires `chatAbortRef.current?.abort()` on
 * `APP_PAUSE_EVENT` to cancel UI-side streams before iOS suspends the
 * WKWebView. That covers the UI's fetch streams. This module covers the
 * runtime side: inference paths internal to the agent (the AOSP llama FFI
 * adapter, the cloud-fallback wrapper, any future locally-driven model
 * call) can register their `AbortController` here so a single hook can
 * abort ALL of them at once on pause / shutdown / account switch.
 *
 * Contract:
 *  - `trackInflight(runtime, ctrl)` returns a disposer. Callers MUST call
 *    the disposer in their `finally` block so completed calls don't keep
 *    references alive.
 *  - `abortInflightInference(runtime)` calls `.abort()` on every tracked
 *    controller for the runtime and clears the set. Returns the count so
 *    the caller can log how many were canceled.
 *  - WeakMap-keyed by runtime so per-account or test-runtime instances
 *    don't leak across each other.
 */
import type { IAgentRuntime } from "@elizaos/core";
/**
 * Register a fresh `AbortController` with the runtime's in-flight set.
 * Returns a disposer that removes the controller from the set; callers
 * MUST invoke it in the finally block so completed calls are GC'd.
 */
export declare function trackInflight(
  runtime: IAgentRuntime,
  controller: AbortController,
): () => void;
/**
 * Abort every in-flight inference controller for the runtime. Called by
 * the UI on `APP_PAUSE_EVENT` and by other shutdown paths (account
 * switch, hard logout, runtime teardown).
 *
 * Returns `{aborted}` so the caller can emit a structured log line.
 * Idempotent — calling on a runtime with no in-flight work returns
 * `{aborted: 0}` and does nothing.
 */
export declare function abortInflightInference(runtime: IAgentRuntime): {
  aborted: number;
};
/**
 * Inspect the current in-flight count without aborting. Used by
 * diagnostics endpoints (e.g. `/api/health` extension) and tests.
 */
export declare function getInflightInferenceCount(
  runtime: IAgentRuntime,
): number;
/**
 * Test-only reset. Wipes the runtime's tracker entirely. Do NOT call
 * from production code.
 *
 * @internal
 */
export declare function __resetInflightInferenceForTests(
  runtime: IAgentRuntime,
): void;
//# sourceMappingURL=inference-abort.d.ts.map
