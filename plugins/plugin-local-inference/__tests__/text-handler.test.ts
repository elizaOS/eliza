/**
 * Text-handler wiring tests.
 *
 * Confirms the unified local provider:
 *   - registers TEXT_SMALL + TEXT_LARGE handlers,
 *   - dispatches both onto the loader registered as "localInferenceLoader",
 *   - threads abort signals through to the loader,
 *   - returns a structured LocalInferenceUnavailableError when the runtime
 *     has no loader at all (so the runtime falls back to a non-local provider
 *     rather than silently serving a zero output).
 *
 * This is the runtime contract every platform path (Linux/macOS/Windows
 * via node-llama-cpp + llama-server, AOSP via plugin-aosp-local-inference,
 * iOS/Android via capacitor-llama) MUST satisfy. The handlers live in
 * provider.ts and look up the loader by name — so as long as a platform's
 * loader registers under "localInferenceLoader" and implements
 * `generate(args)`, the runtime's `useModel(TEXT_*, ...)` reaches the
 * loaded model on every platform.
 */
import { ModelType } from "@elizaos/core";
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

describe("provider TEXT_SMALL / TEXT_LARGE dispatch", () => {
	it("registers both text handlers under the unified provider", () => {
		const handlers = createLocalInferenceModelHandlers();
		expect(typeof handlers[ModelType.TEXT_SMALL]).toBe("function");
		expect(typeof handlers[ModelType.TEXT_LARGE]).toBe("function");
	});

	it("dispatches TEXT_SMALL through the registered loader", async () => {
		const generate = vi.fn(async (args: { prompt: string }) => {
			return `small:${args.prompt}`;
		});
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ generate });

		const result = await handlers[ModelType.TEXT_SMALL]?.(runtime as never, {
			prompt: "hi",
			maxTokens: 32,
		} as never);

		expect(result).toBe("small:hi");
		expect(generate).toHaveBeenCalledTimes(1);
	});

	it("dispatches TEXT_LARGE through the same loader surface (one loader; the slot is opaque to the loader)", async () => {
		const generate = vi.fn(async () => "large:ok");
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ generate });

		const result = await handlers[ModelType.TEXT_LARGE]?.(runtime as never, {
			prompt: "hi",
		} as never);

		expect(result).toBe("large:ok");
		expect(generate).toHaveBeenCalledTimes(1);
	});

	it("threads an AbortSignal through to the loader", async () => {
		const seen: { signal?: AbortSignal } = {};
		const generate = vi.fn(async (args: { signal?: AbortSignal }) => {
			seen.signal = args.signal;
			return "ok";
		});
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ generate });

		const controller = new AbortController();
		await handlers[ModelType.TEXT_SMALL]?.(runtime as never, {
			prompt: "hi",
			signal: controller.signal,
		} as never);

		expect(seen.signal).toBe(controller.signal);
	});

	it("forwards stop sequences, temperature, and top-p verbatim", async () => {
		const generate = vi.fn(async () => "ok");
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ generate });

		await handlers[ModelType.TEXT_LARGE]?.(runtime as never, {
			prompt: "hi",
			stopSequences: ["</done>"],
			temperature: 0.1,
			topP: 0.95,
			maxTokens: 512,
		} as never);

		expect(generate).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "hi",
				stopSequences: ["</done>"],
				temperature: 0.1,
				topP: 0.95,
				maxTokens: 512,
			}),
		);
	});

	it("emits a typed LOCAL_INFERENCE_UNAVAILABLE error when no loader is registered (runtime then falls through to next provider)", async () => {
		const handlers = createLocalInferenceModelHandlers();
		let caught: unknown;
		try {
			await handlers[ModelType.TEXT_SMALL]?.({} as never, {
				prompt: "hi",
			} as never);
		} catch (err) {
			caught = err;
		}
		expect(isLocalInferenceUnavailableError(caught)).toBe(true);
		expect((caught as { reason?: string }).reason).toBe("backend_unavailable");
	});

	it("emits a typed LOCAL_INFERENCE_UNAVAILABLE error when the loader is registered without `generate` (capability_unavailable)", async () => {
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({});
		let caught: unknown;
		try {
			await handlers[ModelType.TEXT_LARGE]?.(runtime as never, {
				prompt: "hi",
			} as never);
		} catch (err) {
			caught = err;
		}
		expect(isLocalInferenceUnavailableError(caught)).toBe(true);
		expect((caught as { reason?: string }).reason).toBe(
			"capability_unavailable",
		);
	});

	it("rejects empty / whitespace-only prompts (invalid_input) — must not silently dispatch (Commandment 8)", async () => {
		const generate = vi.fn(async () => "should-not-fire");
		const handlers = createLocalInferenceModelHandlers();
		const runtime = runtimeWithService({ generate });

		await expect(
			handlers[ModelType.TEXT_SMALL]?.(runtime as never, {
				prompt: "   ",
			} as never),
		).rejects.toMatchObject({
			code: "LOCAL_INFERENCE_UNAVAILABLE",
			reason: "invalid_input",
		});
		expect(generate).not.toHaveBeenCalled();
	});
});

describe("provider TEXT dispatch — arbiter accessor visibility", () => {
	it("does NOT require an arbiter for text — text bypasses the arbiter capability queue and goes straight to the loader", async () => {
		// MemoryArbiter ownership: text is registered with priority-100 in
		// WS1 (see `memory-arbiter.ts` CAPABILITY_ROLE: text → "text-target").
		// The provider's text path, however, calls `loader.generate()`
		// directly — the arbiter is used by the *loader* internally, not by
		// the provider. This test pins that contract: a loader without
		// `getMemoryArbiter()` still serves text generation cleanly.
		const generate = vi.fn(async () => "ok");
		const handlers = createLocalInferenceModelHandlers();
		const runtime = {
			getService: vi.fn((name: string) =>
				name === "localInferenceLoader" ? { generate } : null,
			),
		};
		await expect(
			handlers[ModelType.TEXT_SMALL]?.(runtime as never, {
				prompt: "hi",
			} as never),
		).resolves.toBe("ok");
	});
});
