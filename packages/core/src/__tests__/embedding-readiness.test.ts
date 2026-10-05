/** Exercises named embedding readiness through the real runtime and SQLite adapter. */
import {
	AgentRuntime,
	getEmbeddingVectorSpace,
	identifyEmbeddingVector,
	ModelType,
	runWithStreamingContext,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { expect, test } from "vitest";

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test.each([
	"ready",
	"mismatch",
	"abort",
	"context-abort",
	"probe-failure",
] as const)(
	"named embedding waits for representation initialization (%s)",
	async (mode) => {
		const runtime = new AgentRuntime({
			character: {
				name: "EmbeddingReadiness",
				bio: ["Tests embedding representation initialization"],
			},
			logLevel: "fatal",
		});
		const adapter = SQLiteDatabaseAdapter.create(":memory:", runtime.agentId);
		runtime.registerDatabaseAdapter(adapter);
		await adapter.initialize();
		const entered = barrier();
		const release = barrier();
		const produced = barrier();
		const original = adapter.ensureEmbeddingSpace.bind(adapter);
		let probes = 0;
		adapter.ensureEmbeddingSpace = async (space) => {
			entered.resolve();
			await release.promise;
			if (mode === "probe-failure")
				throw new Error("Representation storage unavailable");
			return original(space);
		};
		runtime.registerModel(
			ModelType.TEXT_EMBEDDING,
			async (_runtime, params) => {
				if (params === null) probes++;
				else produced.resolve();
				return identifyEmbeddingVector(
					[1, 0, 0],
					params !== null && mode === "mismatch"
						? "test:other"
						: "test:expected",
				);
			},
			"readiness-fixture",
			100,
		);
		const initialization = runtime.ensureEmbeddingDimension();
		const observedInitialization = initialization.then(
			() => ({ ok: true as const }),
			(error) => ({ ok: false as const, error }),
		);
		const initializations = [observedInitialization];
		try {
			await entered.promise;
			const concurrentInitialization = runtime.ensureEmbeddingDimension();
			const observedConcurrent = concurrentInitialization.then(
				() => ({ ok: true as const }),
				(error) => ({ ok: false as const, error }),
			);
			initializations.push(observedConcurrent);
			const controller = new AbortController();
			const call = () =>
				runtime.useModel(ModelType.TEXT_EMBEDDING, {
					text: "recall this complete request",
					...(mode === "context-abort" ? {} : { signal: controller.signal }),
				});
			const request =
				mode === "context-abort"
					? runWithStreamingContext(
							{ onStreamChunk: async () => {}, abortSignal: controller.signal },
							call,
						)
					: call();
			let settled = false;
			const observed = request.then(
				(value) => {
					settled = true;
					return { ok: true as const, value };
				},
				(error) => {
					settled = true;
					return { ok: false as const, error };
				},
			);
			await produced.promise;
			await new Promise((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			if (mode === "abort" || mode === "context-abort") {
				controller.abort(new Error("Recall owner cancelled"));
				const result = await observed;
				expect(result.ok).toBe(false);
				if (!result.ok)
					expect(result.error.message).toBe("Recall owner cancelled");
				release.resolve();
			} else {
				release.resolve();
				const result = await observed;
				if (mode === "ready") {
					expect(result.ok).toBe(true);
					if (result.ok)
						expect(getEmbeddingVectorSpace(result.value)).toBe("test:expected");
				} else {
					expect(result.ok).toBe(false);
					if (!result.ok) {
						if (mode === "mismatch")
							expect(result.error.code).toBe("EMBEDDING_SPACE_MISMATCH");
						else {
							const probeResult = await observedInitialization;
							expect(probeResult.ok).toBe(false);
							if (!probeResult.ok) expect(result.error).toBe(probeResult.error);
						}
					}
				}
			}
			expect((await observedInitialization).ok).toBe(mode !== "probe-failure");
			expect((await observedConcurrent).ok).toBe(mode !== "probe-failure");
			expect(probes).toBe(1);
			if (mode === "probe-failure") {
				adapter.ensureEmbeddingSpace = original;
				await runtime.ensureEmbeddingDimension();
				const retried = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
					text: "retry after storage recovery",
				});
				expect(getEmbeddingVectorSpace(retried)).toBe("test:expected");
				expect(probes).toBe(2);
			}
		} finally {
			release.resolve();
			await Promise.all(initializations);
			await runtime.stop();
			await adapter.close();
		}
	},
);

test("first named embedding initializes its representation before returning", async () => {
	const runtime = new AgentRuntime({
		character: { name: "UninitializedEmbedding" },
		logLevel: "fatal",
	});
	const adapter = SQLiteDatabaseAdapter.create(":memory:", runtime.agentId);
	runtime.registerDatabaseAdapter(adapter);
	await adapter.initialize();
	runtime.registerModel(
		ModelType.TEXT_EMBEDDING,
		async () => identifyEmbeddingVector([1, 0, 0], "test:expected"),
		"uninitialized-fixture",
		100,
	);
	try {
		const result = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: "uninitialized recall",
		});
		expect(getEmbeddingVectorSpace(result)).toBe("test:expected");
	} finally {
		await runtime.stop();
		await adapter.close();
	}
});
