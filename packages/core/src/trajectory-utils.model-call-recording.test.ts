/**
 * Deterministic tests for the request-local provider-recording scope (#17532).
 *
 * Key contract changes in the final fix:
 * - `logActiveTrajectoryLlmCall` is the single chokepoint that calls
 *   `markProviderRecordedCall()` — so ALL provider-level logging paths
 *   (recordLlmCall, direct logActiveTrajectoryLlmCall calls like plugin-openai
 *   live streaming) mark the flag.
 * - `runWithModelCallRecordingScope` returns a live mutable `recordingState`
 *   reference, so `.recorded` reflects late-arriving marks from deferred
 *   streaming providers.
 */
import { describe, expect, it } from "vitest";
import {
	isProviderRecordedCall,
	markProviderRecordedCall,
	runInModelCallRecordingScope,
	runWithModelCallRecordingScope,
} from "./trajectory-utils";

describe("runWithModelCallRecordingScope — return shape", () => {
	it("returns the handler result and recordingState.recorded=false when nothing marks", async () => {
		const { result, recordingState } = await runWithModelCallRecordingScope(
			async () => 42,
		);
		expect(result).toBe(42);
		expect(recordingState.recorded).toBe(false);
	});

	it("returns recordingState.recorded=true when the handler marks inside the scope", async () => {
		const { result, recordingState } = await runWithModelCallRecordingScope(
			async () => {
				markProviderRecordedCall();
				return "hello";
			},
		);
		expect(result).toBe("hello");
		expect(recordingState.recorded).toBe(true);
	});

	it("propagates errors from the wrapped function", async () => {
		await expect(
			runWithModelCallRecordingScope(async () => {
				throw new Error("handler failed");
			}),
		).rejects.toThrow("handler failed");

		// The scope should be cleaned up even after an error.
		expect(isProviderRecordedCall()).toBe(false);
	});

	it("recordingState reflects marks even when read outside the scope", async () => {
		const { recordingState } = await runWithModelCallRecordingScope(
			async () => {
				markProviderRecordedCall();
			},
		);
		expect(recordingState.recorded).toBe(true);
		expect(isProviderRecordedCall()).toBe(false);
	});

	it("simulates deferred-streaming: state is mutable after scope exits", async () => {
		const { recordingState } = await runWithModelCallRecordingScope(
			async () => ({ stream: true }),
		);
		expect(recordingState.recorded).toBe(false);
		recordingState.recorded = true;
		expect(recordingState.recorded).toBe(true);
	});

	it("deferred async generator: mark fires during scoped consumption", async () => {
		// Simulates a deferred-streaming provider (like grok.ts) whose
		// recordLlmCall/markProviderRecordedCall fires during async
		// generator consumption, AFTER runWithModelCallRecordingScope exits.
		const { recordingState } = await runWithModelCallRecordingScope(
			// Handler returns a generator immediately (no mark yet)
			async () => ({
				async *[Symbol.asyncIterator]() {
					yield "chunk1";
					yield "chunk2";
					// Provider finalizer fires mark here
					markProviderRecordedCall();
				},
			}),
		);

		expect(recordingState.recorded).toBe(false);

		// Consume the generator inside the re-established scope
		const chunks: string[] = [];
		const iter = (
			await runWithModelCallRecordingScope(async () => ({
				async *[Symbol.asyncIterator]() {
					yield "a";
					markProviderRecordedCall();
					yield "b";
				},
			}))
		).result[Symbol.asyncIterator]();

		// Each .next() re-enters the scope
		let r = await runInModelCallRecordingScope(recordingState, () =>
			iter.next(),
		);
		expect(r.done).toBe(false);
		chunks.push(r.value as string);

		r = await runInModelCallRecordingScope(recordingState, () => iter.next());
		expect(r.done).toBe(false);
		chunks.push(r.value as string);

		// After consuming the mark, recordingState should reflect it
		expect(recordingState.recorded).toBe(true);
		expect(chunks).toEqual(["a", "b"]);
	});
});

describe("runWithModelCallRecordingScope — scope visibility", () => {
	it("is un-recorded inside a fresh scope", async () => {
		let observed: boolean | undefined;
		await runWithModelCallRecordingScope(async () => {
			observed = isProviderRecordedCall();
		});
		expect(observed).toBe(false);
	});

	it("is un-recorded outside any scope", () => {
		expect(isProviderRecordedCall()).toBe(false);
	});

	it("reflects the flag set inside the scope", async () => {
		let observed: boolean | undefined;
		await runWithModelCallRecordingScope(async () => {
			markProviderRecordedCall();
			observed = isProviderRecordedCall();
		});
		expect(observed).toBe(true);
	});

	it("does not leak the flag outside the scope after it ends", async () => {
		await runWithModelCallRecordingScope(async () => {
			markProviderRecordedCall();
		});
		expect(isProviderRecordedCall()).toBe(false);
	});

	it("markProviderRecordedCall is a no-op outside a scope", () => {
		markProviderRecordedCall();
		expect(isProviderRecordedCall()).toBe(false);
	});
});

describe("runWithModelCallRecordingScope — nested scopes", () => {
	it("inner recording does not leak to outer", async () => {
		let outerAfterInner: boolean | undefined;
		let innerObserved: boolean | undefined;

		await runWithModelCallRecordingScope(async () => {
			expect(isProviderRecordedCall()).toBe(false);

			await runWithModelCallRecordingScope(async () => {
				markProviderRecordedCall();
				innerObserved = isProviderRecordedCall();
			});

			outerAfterInner = isProviderRecordedCall();
		});

		expect(innerObserved).toBe(true);
		expect(outerAfterInner).toBe(false);
	});

	it("nested scopes: inner gets its own fresh flag", async () => {
		let innerObserved: boolean | undefined;

		await runWithModelCallRecordingScope(async () => {
			markProviderRecordedCall();

			await runWithModelCallRecordingScope(async () => {
				innerObserved = isProviderRecordedCall();
			});
		});

		expect(innerObserved).toBe(false);
	});
});

describe("runWithModelCallRecordingScope — concurrency", () => {
	it("concurrent scopes cannot suppress one another", async () => {
		const results: { id: string; recorded: boolean }[] = [];

		const task = async (id: string, shouldRecord: boolean) => {
			const { recordingState } = await runWithModelCallRecordingScope(
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 5));
					if (shouldRecord) {
						markProviderRecordedCall();
					}
					await new Promise((resolve) => setTimeout(resolve, 5));
					return id;
				},
			);
			results.push({ id, recorded: recordingState.recorded });
		};

		await Promise.all([task("A", true), task("B", false)]);

		const a = results.find((r) => r.id === "A");
		const b = results.find((r) => r.id === "B");
		expect(a?.recorded).toBe(true);
		expect(b?.recorded).toBe(false);
	});

	it("three concurrent calls: only the marked ones observe their own flag", async () => {
		const results: { id: string; recorded: boolean }[] = [];

		const task = async (id: string, shouldRecord: boolean) => {
			const { recordingState } = await runWithModelCallRecordingScope(
				async () => {
					await new Promise((resolve) =>
						setTimeout(resolve, Math.random() * 10),
					);
					if (shouldRecord) {
						markProviderRecordedCall();
					}
					await new Promise((resolve) =>
						setTimeout(resolve, Math.random() * 10),
					);
					return id;
				},
			);
			results.push({ id, recorded: recordingState.recorded });
		};

		await Promise.all([task("X", true), task("Y", false), task("Z", true)]);

		const x = results.find((r) => r.id === "X");
		const y = results.find((r) => r.id === "Y");
		const z = results.find((r) => r.id === "Z");
		expect(x?.recorded).toBe(true);
		expect(y?.recorded).toBe(false);
		expect(z?.recorded).toBe(true);
	});

	describe("runInModelCallRecordingScope — callback-stream consumption (#17532)", () => {
		it("marks during scoped iteration of a provider stream consumed after the scope exits", async () => {
			// Models the callback-stream path: runWithModelCallRecordingScope wraps
			// the handler, which returns a stream; the scope has already exited by
			// the time the caller iterates. Per-.next() re-entry lets the provider
			// finalizer (markProviderRecordedCall) land, mirroring runtime.ts.
			const { recordingState, result: handlerResult } =
				await runWithModelCallRecordingScope(async () => ({
					async *[Symbol.asyncIterator]() {
						yield "a";
						yield "b";
						markProviderRecordedCall();
					},
				}));

			expect(recordingState.recorded).toBe(false);

			const inner = (handlerResult as unknown as AsyncIterable<string>)[
				Symbol.asyncIterator
			]();
			const chunks: string[] = [];
			while (true) {
				const { done, value } = await runInModelCallRecordingScope(
					recordingState,
					() => inner.next(),
				);
				if (done) break;
				chunks.push(value);
			}

			expect(chunks).toEqual(["a", "b"]);
			expect(recordingState.recorded).toBe(true);
		});

		it("forwards .return() cleanup into the recording scope so a finalizer mark lands", async () => {
			// Models early termination: the caller breaks out of the stream, and the
			// provider iterator's finally block (markProviderRecordedCall) must run
			// inside the scope during cleanup.
			const { recordingState, result: handlerResult } =
				await runWithModelCallRecordingScope(async () => ({
					async *[Symbol.asyncIterator]() {
						try {
							yield "a";
							yield "b";
						} finally {
							markProviderRecordedCall();
						}
					},
				}));

			const inner = (handlerResult as unknown as AsyncIterable<string>)[
				Symbol.asyncIterator
			]();
			await runInModelCallRecordingScope(recordingState, () => inner.next());
			// Early break, then forward .return() into the scope.
			await runInModelCallRecordingScope(recordingState, async () => {
				await inner.return?.();
			});

			expect(recordingState.recorded).toBe(true);
		});
	});
});

describe("runWithModelCallRecordingScope — multi-record per useModel (#17532 review)", () => {
	it("multiple markProviderRecordedCall calls in one scope suppress the generic fallback after the first", async () => {
		// Models a provider handler that makes several wire calls within a
		// single useModel scope — e.g. a retried completion or a multi-step
		// inference that records each sub-call via logActiveTrajectoryLlmCall.
		// Each successful logLlmCall fires markProviderRecordedCall(). The
		// generic fallback (recordUseModelTrajectory) checks
		// recordingState.recorded and skips when true. The contract: once any
		// provider record lands, the flag is set permanently for that scope —
		// subsequent marks are idempotent and the fallback is suppressed.
		const { recordingState } = await runWithModelCallRecordingScope(
			async () => {
				// First wire call — provider records via logActiveTrajectoryLlmCall
				markProviderRecordedCall();
				expect(isProviderRecordedCall()).toBe(true);

				// Second wire call — provider records again (idempotent mark)
				markProviderRecordedCall();
				expect(isProviderRecordedCall()).toBe(true);

				// Third wire call — provider records again (idempotent mark)
				markProviderRecordedCall();
				expect(isProviderRecordedCall()).toBe(true);

				return "multi-call result";
			},
		);

		// After the scope exits, recordingState.recorded is still true.
		// recordUseModelTrajectory would see providerRecorded=true and skip,
		// producing no generic fallback entry — no double-counting.
		expect(recordingState.recorded).toBe(true);
	});

	it("markProviderRecordedCall called zero times leaves the flag false (generic fallback fires)", async () => {
		// A provider handler that records nothing leaves the flag false, so
		// the generic fallback (recordUseModelTrajectory) produces exactly one
		// trajectory entry for the call.
		const { recordingState } = await runWithModelCallRecordingScope(
			async () => "no provider record",
		);
		expect(recordingState.recorded).toBe(false);
	});
});
