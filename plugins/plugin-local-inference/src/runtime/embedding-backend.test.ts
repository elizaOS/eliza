/** Exercises real backend selection, token agreement and semantic validation with a controlled native FFI boundary. */

import { ElizaError } from "@elizaos/core";
import { prepareBgeEmbeddingInput } from "@elizaos/plugin-native-inference/model-catalog/bge-input";
import { describe, expect, it } from "vitest";
import { ELIZA_POOLING_CLS } from "../services/voice/ffi-bindings";
import {
	createVerifiedBgeContext,
	resolveEmbeddingBackendPolicy,
} from "./embedding-backend";
import { BGE_SEMANTIC_PROBE_INPUTS } from "./embedding-vector-space";

function nativeBoundary(
	gpuFailure:
		| "collapsed"
		| "nonfinite"
		| "tokenizer"
		| "native"
		| "none" = "collapsed",
	cpuFailure = false,
) {
	const contexts = new Map<bigint, number>();
	const created: number[] = [];
	const destroyed: bigint[] = [];
	let next = 0n;
	const ffi = {
		create(_bundle: string, options?: { gpuLayers: number }) {
			if (!options) throw new Error("Context policy is required");
			const ctx = ++next;
			contexts.set(ctx, options.gpuLayers);
			created.push(options.gpuLayers);
			return ctx;
		},
		destroy(ctx: bigint) {
			if (!contexts.delete(ctx)) throw new Error("Context destroyed twice");
			destroyed.push(ctx);
		},
		tokenize({ ctx, text }: { ctx: bigint; text: string }) {
			const layers = contexts.get(ctx);
			if (layers === undefined) throw new Error("Context is not alive");
			if (layers > 0 && gpuFailure === "tokenizer") return new Int32Array([1]);
			return Int32Array.from(prepareBgeEmbeddingInput(text).tokenIds);
		},
		embed({ ctx, text }: { ctx: bigint; text: string }) {
			const layers = contexts.get(ctx);
			if (layers === undefined) throw new Error("Context is not alive");
			if (layers > 0 && gpuFailure === "native")
				throw new Error("Native failure without a typed vector diagnosis");
			const vector = new Float32Array(384);
			if (layers > 0 && gpuFailure === "nonfinite") {
				vector[0] = NaN;
				return vector;
			}
			if (
				(layers > 0 && gpuFailure === "collapsed") ||
				(layers === 0 && cpuFailure)
			) {
				vector[0] = 1;
				return vector;
			}
			vector[text === BGE_SEMANTIC_PROBE_INPUTS[2] ? 1 : 0] = 1;
			return vector;
		},
	};
	return { ffi, created, destroyed, contexts };
}

const open = (
	boundary: ReturnType<typeof nativeBoundary>,
	configured?: string,
	detected = 999,
) =>
	createVerifiedBgeContext(
		boundary.ffi,
		"/isolated/bge",
		resolveEmbeddingBackendPolicy(configured, detected),
		ELIZA_POOLING_CLS,
		512,
	);

describe("verified BGE backend selection", () => {
	it("keeps a healthy automatic GPU context without creating CPU", () => {
		const b = nativeBoundary("none");
		const selected = open(b);
		expect(selected.gpuLayers).toBe(999);
		expect(selected.related).toBeGreaterThan(selected.unrelated + 0.1);
		expect(b.created).toEqual([999]);
		expect(b.destroyed).toEqual([]);
		b.ffi.destroy(selected.ctx);
	});
	it.each(["collapsed", "nonfinite"] as const)(
		"releases a %s automatic GPU before accepting independently verified CPU",
		(failure) => {
			const b = nativeBoundary(failure);
			const selected = open(b);
			expect(b.created).toEqual([999, 0]);
			expect(b.destroyed).toEqual([1n]);
			expect(selected.gpuLayers).toBe(0);
			expect(b.contexts.size).toBe(1);
			b.ffi.destroy(selected.ctx);
			expect(b.destroyed).toEqual([1n, 2n]);
		},
	);
	it.each(["auto", "max", "1", "999"])(
		"never silently changes the explicit %s backend",
		(configured) => {
			const b = nativeBoundary();
			expect(() => open(b, configured)).toThrow(ElizaError);
			expect(b.created).toEqual([configured === "1" ? 1 : 999]);
			expect(b.destroyed).toEqual([1n]);
			expect(b.contexts.size).toBe(0);
		},
	);
	it.each(["0", undefined])(
		"uses only CPU for explicit zero or absent accelerator evidence (%s)",
		(configured) => {
			const b = nativeBoundary();
			const selected = open(b, configured, 0);
			expect(b.created).toEqual([0]);
			b.ffi.destroy(selected.ctx);
		},
	);
	it("rejects CPU too when both semantic probes fail", () => {
		const b = nativeBoundary("collapsed", true);
		expect(() => open(b)).toThrow(ElizaError);
		expect(b.created).toEqual([999, 0]);
		expect(b.destroyed).toEqual([1n, 2n]);
		expect(b.contexts.size).toBe(0);
	});
	it.each(["tokenizer", "native"] as const)(
		"does not treat a %s failure as permission to change backend",
		(failure) => {
			const b = nativeBoundary(failure);
			expect(() => open(b)).toThrow();
			expect(b.created).toEqual([999]);
			expect(b.destroyed).toEqual([1n]);
		},
	);
	it("rejects invalid operator settings before allocating a context", () => {
		const b = nativeBoundary();
		expect(() => open(b, "-1")).toThrow(ElizaError);
		expect(b.created).toEqual([]);
	});
	it("reopens after releasing each selected context without leaking rejected candidates", () => {
		const b = nativeBoundary();
		for (let cycle = 0; cycle < 2; cycle++) {
			const selected = open(b);
			b.ffi.destroy(selected.ctx);
		}
		expect(b.created).toEqual([999, 0, 999, 0]);
		expect(b.destroyed).toEqual([1n, 2n, 3n, 4n]);
		expect(b.contexts.size).toBe(0);
	});
});
