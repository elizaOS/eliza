import { describe, expect, it, vi } from "vitest";
import { loadAospImageGenBackend } from "./aosp-unavailable.js";
import {
	ImageGenBackendUnavailableError,
	isImageGenUnavailable,
} from "./errors.js";
import { resolveSeed } from "./sd-cpp.js";

function makeBinding(handle: unknown, hasImageGen = true) {
	return {
		hasImageGen: () => hasImageGen,
		initImageGen: vi.fn().mockResolvedValue(handle),
	};
}

function makeHandle() {
	return {
		generate: vi
			.fn()
			.mockResolvedValue({
				png: new Uint8Array([1]),
				seedUsed: 7,
				inferenceMs: 12,
			}),
		dispose: vi.fn().mockResolvedValue(undefined),
	};
}

function makeRequest(overrides: Record<string, unknown> = {}) {
	return {
		prompt: "a cat",
		width: 512,
		height: 512,
		seed: 3,
		...overrides,
	};
}

async function makeBackend(opts: {
	binding?: unknown;
	handle?: unknown;
	hasImageGen?: boolean;
	now?: () => number;
}) {
	const handle = opts.handle ?? makeHandle();
	const binding = opts.binding ?? makeBinding(handle, opts.hasImageGen);
	return loadAospImageGenBackend({
		loadArgs: { modelPath: "/m.gguf", accelerator: "auto" },
		modelKey: "z-image",
		binding: binding as never,
		now: opts.now,
	});
}

describe("loadAospImageGenBackend", () => {
	it("throws a structured unavailable error when no binding is provided", async () => {
		await expect(
			loadAospImageGenBackend({
				loadArgs: { modelPath: "/m.gguf" },
				modelKey: "z-image",
			}),
		).rejects.toMatchObject({
			code: "IMAGE_GEN_BACKEND_UNAVAILABLE",
			reason: "binding_unavailable",
			backendId: "aosp",
		});
	});

	it("throws when the binding reports no imagegen symbols", async () => {
		await expect(makeBackend({ hasImageGen: false })).rejects.toMatchObject({
			code: "IMAGE_GEN_BACKEND_UNAVAILABLE",
			reason: "binding_unavailable",
		});
	});

	it("rejects out-of-range dimensions in supports()", async () => {
		const backend = await makeBackend({});
		expect(backend.supports(makeRequest({ width: 0 }))).toBe(false);
		expect(backend.supports(makeRequest({ height: -1 }))).toBe(false);
		expect(backend.supports(makeRequest({ width: 2049 }))).toBe(false);
		expect(backend.supports(makeRequest({ height: 4096 }))).toBe(false);
		expect(backend.supports(makeRequest())).toBe(true);
		expect(backend.supports(makeRequest({ width: 2048, height: 2048 }))).toBe(
			true,
		);
	});

	it("refuses generate() after dispose() (state machine guard)", async () => {
		const handle = makeHandle();
		const backend = await makeBackend({ handle });
		await backend.dispose();
		await expect(backend.generate(makeRequest())).rejects.toMatchObject({
			code: "IMAGE_GEN_BACKEND_UNAVAILABLE",
			reason: "binding_unavailable",
		});
		expect(handle.generate).not.toHaveBeenCalled();
	});

	it("refuses empty prompts as unsupported_request", async () => {
		const handle = makeHandle();
		const backend = await makeBackend({ handle });
		await expect(
			backend.generate(makeRequest({ prompt: "   " })),
		).rejects.toMatchObject({
			code: "IMAGE_GEN_BACKEND_UNAVAILABLE",
			reason: "unsupported_request",
		});
		expect(handle.generate).not.toHaveBeenCalled();
	});

	it("applies defaults and forwards the resolved seed on the happy path", async () => {
		const handle = makeHandle();
		const backend = await makeBackend({ handle });
		const result = await backend.generate(makeRequest({ seed: -2 }));
		expect(handle.generate).toHaveBeenCalledWith({
			prompt: "a cat",
			negativePrompt: undefined,
			width: 512,
			height: 512,
			steps: 4,
			guidanceScale: 0,
			seed: resolveSeed(-2),
			scheduler: undefined,
			signal: undefined,
		});
		expect(result.mime).toBe("image/png");
		expect(result.image).toBeInstanceOf(Uint8Array);
		expect(result.seed).toBe(7);
		expect(result.metadata.model).toBe("z-image");
	});

	it("falls back to wall-clock elapsed when inferenceMs is not positive", async () => {
		const handle = makeHandle();
		let t = 1000;
		handle.generate.mockImplementation(async () => {
			// The real native call takes wall-clock time; advance the injected
			// clock inside the awaited call so the fallback has a delta to read.
			t += 500;
			return { png: new Uint8Array([1]), seedUsed: 1, inferenceMs: 0 };
		});
		const backend = await makeBackend({ handle, now: () => t });
		const result = await backend.generate(makeRequest());
		expect(result.metadata.inferenceTimeMs).toBe(500);
	});

	it("falls back to the requested seed when seedUsed is not a number", async () => {
		const handle = makeHandle();
		handle.generate.mockResolvedValue({
			png: new Uint8Array([1]),
			seedUsed: "nope",
			inferenceMs: 5,
		});
		const backend = await makeBackend({ handle });
		const result = await backend.generate(makeRequest({ seed: 11 }));
		expect(result.seed).toBe(11);
	});

	it("reports progress once with the full step count", async () => {
		const handle = makeHandle();
		const backend = await makeBackend({ handle });
		const onProgressChunk = vi.fn();
		await backend.generate(makeRequest({ onProgressChunk }));
		expect(onProgressChunk).toHaveBeenCalledWith({ step: 4, total: 4 });
	});

	it("dispose is idempotent", async () => {
		const handle = makeHandle();
		const backend = await makeBackend({ handle });
		await backend.dispose();
		await backend.dispose();
		expect(handle.dispose).toHaveBeenCalledTimes(1);
	});

	it("emits errors that satisfy isImageGenUnavailable", async () => {
		const err = new ImageGenBackendUnavailableError(
			"aosp",
			"binding_unavailable",
			"no symbols",
		);
		expect(isImageGenUnavailable(err)).toBe(true);
		expect(isImageGenUnavailable(new Error("x"))).toBe(false);
	});
});
