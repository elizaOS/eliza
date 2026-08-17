/**
 * Unit coverage for the unregistered embedding-handler factory. The runtime
 * boot path decides whether a loader is trusted enough to register; once a
 * trusted path invokes this factory, outputs still must satisfy the canonical
 * BGE-small 384-dimensional, finite, nonzero, L2-normalized contract.
 */
import { CANONICAL_EMBEDDING_DIMENSION, ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	createLocalInferenceModelHandlers,
	isLocalInferenceUnavailableError,
} from "../src/provider.ts";

function runtimeWithService(service: Record<string, unknown>) {
	return {
		getService: vi.fn((name: string) =>
			name === "localInferenceLoader" ? service : null,
		),
	};
}

function makeCanonicalUnitVector(index = 0): number[] {
	return Array.from(
		{ length: CANONICAL_EMBEDDING_DIMENSION },
		(_, position) => (position === index ? 1 : 0),
	);
}

describe("provider TEXT_EMBEDDING dispatch", () => {
	it("registers a TEXT_EMBEDDING handler", () => {
		const handlers = createLocalInferenceModelHandlers();
		expect(typeof handlers[ModelType.TEXT_EMBEDDING]).toBe("function");
	});

	it("dispatches embed({ input }) and returns a canonical unit vector", async () => {
		const expected = makeCanonicalUnitVector();
		const embed = vi.fn(async (args: { input: string }) => {
			expect(args.input).toBe("hello world");
			return expected;
		});
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		const result = await handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
			text: "hello world",
		} as never);

		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual(expected);
		expect((result as number[]).length).toBe(
			CANONICAL_EMBEDDING_DIMENSION,
		);
	});

	it("accepts a raw string input (action-runner shape) without re-wrapping", async () => {
		const expected = makeCanonicalUnitVector(1);
		const embed = vi.fn(async (args: { input: string }) => {
			expect(args.input).toBe("plain string");
			return expected;
		});
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		const result = await handlers[ModelType.TEXT_EMBEDDING]?.(
			runtime as never,
			"plain string" as never,
		);
		expect(result).toEqual(expected);
	});

	it("accepts the { embedding: number[] } loader shape too", async () => {
		const expected = makeCanonicalUnitVector(2);
		const embed = vi.fn(async () => ({ embedding: expected }));
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		const result = await handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
			text: "shape variant",
		} as never);
		expect(result).toEqual(expected);
	});

	it("returns the same normalized vector for the same input", async () => {
		let counter = 0;
		const fixed = makeCanonicalUnitVector(3);
		const embed = vi.fn(async () => {
			counter += 1;
			return fixed;
		});
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		const a = await handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
			text: "stable",
		} as never);
		const b = await handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
			text: "stable",
		} as never);

		expect(counter).toBe(2);
		expect(a).toEqual(b);
		expect((a as number[]).length).toBe((b as number[]).length);
	});

	it("normalizes a finite canonical-width loader result", async () => {
		const raw = Array.from(
			{ length: CANONICAL_EMBEDDING_DIMENSION },
			(_, index) => (index === 0 ? 3 : index === 1 ? 4 : 0),
		);
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed: vi.fn(async () => raw) });

		const result = (await handlers[ModelType.TEXT_EMBEDDING]?.(
			runtime as never,
			{ text: "normalize me" } as never,
		)) as number[];

		expect(result[0]).toBeCloseTo(0.6);
		expect(result[1]).toBeCloseTo(0.8);
		expect(Math.hypot(...result)).toBeCloseTo(1);
	});

	it("rejects null warmup probes — must NOT serve a fake zero vector (Commandment 8)", async () => {
		const embed = vi.fn();
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		let caught: unknown;
		try {
			await handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, null as never);
		} catch (err) {
			caught = err;
		}
		expect(isLocalInferenceUnavailableError(caught)).toBe(true);
		expect((caught as { reason?: string }).reason).toBe("invalid_input");
		expect(embed).not.toHaveBeenCalled();
	});

	it("rejects empty-string input", async () => {
		const embed = vi.fn();
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		await expect(
			handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
				text: "",
			} as never),
		).rejects.toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			reason: "invalid_input",
		});
		expect(embed).not.toHaveBeenCalled();
	});

	it("rejects a loader that returns a non-numeric array (invalid_output)", async () => {
		const embed = vi.fn(async () => ["not", "a", "vector"] as unknown as number[]);
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ embed });

		await expect(
			handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
				text: "hi",
			} as never),
		).rejects.toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			reason: "invalid_output",
		});
	});

	it("rejects a noncanonical embedding width", async () => {
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({
			embed: vi.fn(async () => [0.6, 0.8]),
		});

		await expect(
			handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
				text: "wrong width",
			} as never),
		).rejects.toThrow(`expected ${CANONICAL_EMBEDDING_DIMENSION}`);
	});

	it("rejects when no loader is registered instead of returning zero vectors", async () => {
		const handlers = createLocalInferenceModelHandlers();
		await expect(
			handlers[ModelType.TEXT_EMBEDDING]?.({} as never, {
				text: "hi",
			} as never),
		).rejects.toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			reason: "backend_unavailable",
		});
	});

	it("emits capability_unavailable when the loader has no `embed`", async () => {
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({});

		await expect(
			handlers[ModelType.TEXT_EMBEDDING]?.(runtime as never, {
				text: "hi",
			} as never),
		).rejects.toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			reason: "capability_unavailable",
		});
	});
});
