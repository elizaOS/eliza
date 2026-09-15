/** Coordinates coalesced provider execution, per-caller cancellation, and complete provider-result observations. Shared work is cancelled only when its final interested caller leaves or the runtime stops. */

import type { ElizaError } from "../../errors";
import type { ProviderResult } from "../../types";
import { TurnAbortedError } from "../turn-controller";

export type ProviderExecutionOutcome = "success" | "error" | "aborted";

export interface ProviderExecutionRecord extends ProviderResult {
	providerName: string;
	providerStartedAt: number;
	providerEndedAt: number;
	providerDurationMs: number;
	providerOutcome: ProviderExecutionOutcome;
	providerCoalesced: boolean;
	providerError?: ElizaError;
}

export interface CachedProviderResult extends ProviderResult {
	providerName: string;
	providerStartedAt?: number;
	providerEndedAt?: number;
	providerDurationMs?: number;
	providerOutcome?: ProviderExecutionOutcome;
}

export interface InFlightProviderExecution {
	promise: Promise<ProviderResult>;
	// The execution owns its abort authority: callers race the shared promise
	// against their OWN turn signal and this controller fires only when the
	// last interested caller has aborted. Wiring the work directly to the
	// first caller's signal would swallow a later coalesced waiter's "stop"
	// entirely, and push the first caller's abort reason into turns that never
	// requested it.
	controller: AbortController;
	// Every consumer of this execution MUST attach through awaitProviderExecution
	// rather than awaiting `promise` directly: an uncounted caller would not
	// register as a waiter, so the accounting below could abort the shared
	// work out from under it.
	waiters: number;
	startedAt: number;
	startedAtMonotonic: number;
}

// Per-waiter cancellation boundary for a (possibly coalesced) provider
// execution. Each caller observes its own signal: an aborting waiter rejects
// immediately with ITS reason while the shared work keeps running for the
// remaining callers, and the shared work is aborted exactly when the caller
// count drops to zero — so a lone caller's abort still reaches the provider.
//
// EVERY attached caller counts toward `waiters`, including callers with no
// signal (composeState outside any turn or streaming context — signalFor and
// getStreamingContext are both legitimately undefined there). The abort
// condition reads `waiters` as "is anyone still interested", so exempting
// signal-less callers would let a cancelling waiter abort work an uncounted
// caller is still awaiting.
//
// `evict` removes the in-flight map entry for this execution. It must run
// SYNCHRONOUSLY, immediately before `controller.abort()`, rather than being
// left to the `promise.then(cleanup, cleanup)` at the call site: that cleanup
// only fires once the shared promise finishes unwinding through
// runProviderExecution/withProviderStep, a microtask or more after the
// synchronous abort. A composeState call landing in that window would
// otherwise `get()` the dying execution and inherit an abort reason it never
// asked for. Evicting here makes the entry unreachable at the moment it stops
// being viable instead of when its promise settles.
export function awaitProviderExecution(
	execution: InFlightProviderExecution,
	signal: AbortSignal | undefined,
	evict: () => void,
): Promise<ProviderResult> {
	execution.waiters += 1;
	let released = false;
	const release = () => {
		if (released) return false;
		released = true;
		execution.waiters -= 1;
		return true;
	};
	if (!signal) {
		return execution.promise.finally(release);
	}
	return new Promise<ProviderResult>((resolve, reject) => {
		const settle = <V>(handler: (value: V) => void) => {
			return (value: V) => {
				if (!release()) return;
				signal.removeEventListener("abort", onAbort);
				handler(value);
			};
		};
		const onAbort = settle(() => {
			if (execution.waiters === 0) {
				evict();
				execution.controller.abort(signal.reason);
			}
			reject(signal.reason ?? new Error("Provider execution aborted"));
		});
		// Attach the settle handlers to `execution.promise` BEFORE checking
		// `signal.aborted`: an already-aborted caller still needs a rejection
		// handler wired up, or the shared promise's eventual rejection (driven
		// by the `controller.abort()` below) goes unhandled and crashes the
		// process under Node's default unhandled-rejection behavior.
		execution.promise.then(settle(resolve), settle(reject));
		if (signal.aborted) {
			onAbort(undefined);
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function calculateProviderOverlaps(
	timings: readonly {
		providerName: string;
		providerStartedAt: number;
		providerEndedAt: number;
	}[],
): Array<Array<{ providerName: string; overlapMs: number }>> {
	return timings.map((timing, index) =>
		timings.flatMap((sibling, siblingIndex) => {
			if (siblingIndex === index) return [];
			const overlapMs = Math.max(
				0,
				Math.min(timing.providerEndedAt, sibling.providerEndedAt) -
					Math.max(timing.providerStartedAt, sibling.providerStartedAt),
			);
			return overlapMs > 0
				? [{ providerName: sibling.providerName, overlapMs }]
				: [];
		}),
	);
}

// Shared provider work has one execution-owned cancellation boundary. Each
// composeState caller races that work against its own owner signal in
// awaitProviderExecution; this boundary stops waiting for non-cooperative work
// when the final caller leaves or the runtime stops, while Promise.race keeps
// the detached provider promise observed.
export function runProviderExecution<T>(
	run: () => Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	let rejectFromSignal: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		rejectFromSignal = () => {
			reject(signal.reason ?? new Error("Provider execution aborted"));
		};
		if (signal.aborted) {
			rejectFromSignal?.();
			return;
		}
		signal.addEventListener("abort", rejectFromSignal, {
			once: true,
		});
	});
	const providerPromise = Promise.resolve().then(() => {
		// The execution controller can be aborted after this promise is created
		// but before its microtask starts (an already-cancelled caller and runtime
		// teardown both take this path). Recheck here so provider work never begins
		// after its final lifecycle owner has already departed.
		if (signal.aborted) {
			throw signal.reason ?? new Error("Provider execution aborted");
		}
		return run();
	});
	return Promise.race([providerPromise, aborted]).finally(() => {
		if (rejectFromSignal) {
			signal.removeEventListener("abort", rejectFromSignal);
		}
	});
}

export function providerCancellationReason(
	callerSignal: AbortSignal | undefined,
	executionSignal: AbortSignal,
	cause: unknown,
): boolean {
	return (
		(callerSignal?.aborted === true && cause === callerSignal.reason) ||
		(executionSignal.aborted && cause === executionSignal.reason)
	);
}

export function throwIfProviderCompositionAborted(
	signal: AbortSignal | undefined,
	runtimeStopped: boolean,
): void {
	if (signal?.aborted) {
		const reason = signal.reason;
		throw reason instanceof TurnAbortedError
			? reason
			: new TurnAbortedError(
					reason instanceof Error ? reason.message : String(reason),
				);
	}
	if (runtimeStopped) {
		throw new TurnAbortedError("runtime-stop");
	}
}
