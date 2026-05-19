/**
 * Tests for the narrow `LlmStreamingBinding` interface + the
 * `wrapElizaInferenceFfi` adapter that promotes the optional-shaped
 * libelizainference surface to the required-shape narrow contract.
 */

import { describe, expect, it, vi } from "vitest";
import { wrapElizaInferenceFfi } from "../llm-streaming-binding";
import type { ElizaInferenceFfi, LlmStreamHandle } from "../voice/ffi-bindings";

function makeFullyImplementedFfi(): ElizaInferenceFfi {
	return {
		libraryPath: "/fake",
		libraryAbiVersion: "5",
		create: vi.fn(),
		destroy: vi.fn(),
		mmapAcquire: vi.fn(),
		mmapEvict: vi.fn(),
		ttsSynthesize: vi.fn().mockReturnValue(0),
		asrTranscribe: vi.fn().mockReturnValue(""),
		ttsStreamSupported: () => false,
		ttsSynthesizeStream: vi.fn(),
		llmStreamSupported: () => true,
		llmStreamOpen: vi.fn().mockReturnValue(1n as LlmStreamHandle),
		llmStreamPrefill: vi.fn(),
		llmStreamNext: vi.fn().mockReturnValue({
			tokens: [],
			text: "",
			done: true,
			drafterDrafted: 0,
			drafterAccepted: 0,
		}),
		llmStreamCancel: vi.fn(),
		llmStreamSaveSlot: vi.fn(),
		llmStreamRestoreSlot: vi.fn(),
		llmStreamClose: vi.fn(),
		close: vi.fn(),
	} as unknown as ElizaInferenceFfi;
}

describe("wrapElizaInferenceFfi", () => {
	it("returns a binding when all llmStream* symbols are present", () => {
		const ffi = makeFullyImplementedFfi();
		const binding = wrapElizaInferenceFfi(ffi);
		expect(binding.llmStreamSupported()).toBe(true);
		expect(typeof binding.llmStreamOpen).toBe("function");
		expect(typeof binding.llmStreamPrefill).toBe("function");
		expect(typeof binding.llmStreamNext).toBe("function");
		expect(typeof binding.llmStreamCancel).toBe("function");
		expect(typeof binding.llmStreamClose).toBe("function");
		// Save/restore slot are optional on the narrow interface — but
		// present here because the test mock supplies them.
		expect(typeof binding.llmStreamSaveSlot).toBe("function");
		expect(typeof binding.llmStreamRestoreSlot).toBe("function");
	});

	it("throws when llmStreamSupported() returns false (old library)", () => {
		const ffi = makeFullyImplementedFfi();
		(ffi as { llmStreamSupported: () => boolean }).llmStreamSupported = () =>
			false;
		expect(() => wrapElizaInferenceFfi(ffi)).toThrow(
			/does not expose the streaming-LLM symbol set/,
		);
	});

	it("throws when a required llmStream* symbol is missing", () => {
		const ffi = makeFullyImplementedFfi() as unknown as Record<string, unknown>;
		delete ffi.llmStreamOpen;
		expect(() =>
			wrapElizaInferenceFfi(ffi as unknown as ElizaInferenceFfi),
		).toThrow(/does not expose the streaming-LLM symbol set/);
	});

	it("propagates calls through to the underlying ffi methods", () => {
		const ffi = makeFullyImplementedFfi();
		const binding = wrapElizaInferenceFfi(ffi);
		binding.llmStreamOpen({
			ctx: 1n as never,
			config: {} as never,
		});
		expect(ffi.llmStreamOpen).toHaveBeenCalledTimes(1);
		binding.llmStreamCancel(1n as LlmStreamHandle);
		expect(ffi.llmStreamCancel).toHaveBeenCalledTimes(1);
	});
});
