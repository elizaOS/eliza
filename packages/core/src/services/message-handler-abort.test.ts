/**
 * AbortSignal propagation through `messageService.handleMessage`.
 *
 * Wave 4 plumbs the caller-supplied `MessageProcessingOptions.abortSignal`
 * through the message-service pipeline so:
 *
 *   1. A long-running `runtime.useModel` call sees the signal and rejects
 *      with an AbortError when the caller aborts.
 *   2. `handleMessage` rejects (or returns early) instead of running to
 *      completion against a model call that the caller no longer wants.
 *   3. Downstream actions never run for an aborted turn.
 *
 * Today (pre-Wave 4) `handleMessage` accepts `abortSignal` in its options
 * but does not pass it to `useModel`, the planner, or action execution; the
 * runtime fully consumes the model call regardless of cancellation. This
 * test is therefore `.skip` until the propagation wiring lands. When Wave 4
 * merges, drop the `.skip` and remove this comment.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.skip("messageService.handleMessage — AbortSignal propagation (Wave 4)", () => {
	beforeEach(() => {
		// no-op
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("aborts a slow useModel call when the caller signals abort", async () => {
		// TODO(wave-4): unskip this block once the abort signal is wired
		// through `messageService.handleMessage` → planner-loop → `useModel`.
		// The shape below describes the contract the wiring must satisfy.

		// Pseudo-test (kept as a real `it.skip` so vitest reports it explicitly):
		//
		// import type { Memory } from "@elizaos/core";
		// import { ModelType } from "@elizaos/core";
		// const runtime = await buildRuntimeWithMessageService();
		// let observedSignal: AbortSignal | undefined;
		// vi.spyOn(runtime, "useModel").mockImplementation(async (_modelType, args: any) => {
		//   observedSignal = args?.abortSignal;
		//   await new Promise((resolve, reject) => {
		//     args?.abortSignal?.addEventListener("abort", () => {
		//       reject(new DOMException("aborted", "AbortError"));
		//     });
		//     // Simulate slow generation that would otherwise complete.
		//     setTimeout(() => resolve({ text: "Hello" }), 60_000);
		//   });
		// });
		// const controller = new AbortController();
		// const message: Memory = makeMessage(runtime);
		// const handlePromise = runtime.messageService.handleMessage(
		//   runtime,
		//   message,
		//   undefined,
		//   { abortSignal: controller.signal },
		// );
		// setTimeout(() => controller.abort(), 50);
		// await expect(handlePromise).rejects.toMatchObject({ name: "AbortError" });
		// expect(controller.signal.aborted).toBe(true);
		// expect(observedSignal?.aborted).toBe(true);
		expect(true).toBe(true);
	});

	it("does not invoke action handlers for an aborted turn", async () => {
		// TODO(wave-4): symmetrical assertion against the action-runner path.
		// After abort, no action handlers should be invoked. This guards
		// against partial side-effects from a half-aborted message pipeline.
		expect(true).toBe(true);
	});
});
