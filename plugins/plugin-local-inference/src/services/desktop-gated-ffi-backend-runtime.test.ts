import { afterEach, describe, expect, it } from "vitest";
import type { BackendPlan } from "./backend";
import { resolveFusedLibraryPath } from "./desktop-fused-ffi-backend-runtime";
import { DesktopGatedFfiBackendRuntime } from "./desktop-gated-ffi-backend-runtime";
import type {
	FfiBackendRuntime,
	FfiBackendSession,
} from "./ffi-streaming-backend";

/**
 * The gate decides WHICH native lib serves the in-process llama.cpp path: the
 * fused `libelizainference` (preferred when its v8 MTP/KV-quant probes pass) or
 * the libllama runtime (the optimization-carrying fallback + the
 * vision-describe path). These tests drive the selection logic with fake
 * runtimes — no bun:ffi, no native load.
 */

function fakeSession(tag: string): FfiBackendSession {
	return {
		binding: {} as never,
		ctx: {} as never,
		runner: {} as never,
		tokenize: () => new Int32Array(),
		mtp: null,
		draftModelPath: null,
		mmprojPath: tag === "vision" ? "/fake/mmproj.gguf" : null,
		loadConfig: null,
	};
}

class FakeRuntime implements FfiBackendRuntime {
	acquired = 0;
	released = 0;
	constructor(
		readonly name: string,
		private supportedValue: boolean,
	) {}
	supported(): boolean {
		return this.supportedValue;
	}
	setSupported(v: boolean): void {
		this.supportedValue = v;
	}
	async acquire(_plan: BackendPlan): Promise<FfiBackendSession> {
		this.acquired += 1;
		return fakeSession(this.name);
	}
	async release(): Promise<void> {
		this.released += 1;
	}
	parallelSlots(): number {
		return 1;
	}
}

const TEXT_PLAN: BackendPlan = {
	modelPath: "/bundle/text/eliza-1-4b-128k.gguf",
	overrides: { bundleRoot: "/bundle" },
};
const VISION_PLAN: BackendPlan = {
	modelPath: "/bundle/text/eliza-1-4b-128k.gguf",
	overrides: {
		bundleRoot: "/bundle",
		mmprojPath: "/bundle/vision/mmproj.gguf",
	},
};

describe("DesktopGatedFfiBackendRuntime", () => {
	it("prefers the fused runtime for a text-only load when its probes pass", async () => {
		const fused = new FakeRuntime("fused", true);
		const libllama = new FakeRuntime("libllama", true);
		const gate = new DesktopGatedFfiBackendRuntime(
			fused as never,
			libllama as never,
		);
		expect(gate.fusedPreferred()).toBe(true);
		await gate.acquire(TEXT_PLAN);
		expect(fused.acquired).toBe(1);
		expect(libllama.acquired).toBe(0);
		await gate.release();
		expect(fused.released).toBe(1);
	});

	it("falls back to libllama when the fused probes fail (old/absent fused lib)", async () => {
		const fused = new FakeRuntime("fused", false);
		const libllama = new FakeRuntime("libllama", true);
		const gate = new DesktopGatedFfiBackendRuntime(
			fused as never,
			libllama as never,
		);
		expect(gate.fusedPreferred()).toBe(false);
		await gate.acquire(TEXT_PLAN);
		expect(fused.acquired).toBe(0);
		expect(libllama.acquired).toBe(1);
	});

	it("routes vision loads (mmproj present) to libllama even when fused is preferred", async () => {
		const fused = new FakeRuntime("fused", true);
		const libllama = new FakeRuntime("libllama", true);
		const gate = new DesktopGatedFfiBackendRuntime(
			fused as never,
			libllama as never,
		);
		await gate.acquire(VISION_PLAN);
		expect(fused.acquired).toBe(0);
		expect(libllama.acquired).toBe(1);
	});

	it("reports supported when either runtime is usable, unsupported when neither is", () => {
		const fused = new FakeRuntime("fused", false);
		const libllama = new FakeRuntime("libllama", false);
		const gate = new DesktopGatedFfiBackendRuntime(
			fused as never,
			libllama as never,
		);
		expect(gate.supported()).toBe(false);
		libllama.setSupported(true);
		expect(gate.supported()).toBe(true);
	});

	it("guards against a double acquire", async () => {
		const fused = new FakeRuntime("fused", true);
		const libllama = new FakeRuntime("libllama", true);
		const gate = new DesktopGatedFfiBackendRuntime(
			fused as never,
			libllama as never,
		);
		await gate.acquire(TEXT_PLAN);
		await expect(gate.acquire(TEXT_PLAN)).rejects.toThrow(/live session/);
	});

	it("release is idempotent with no active session", async () => {
		const fused = new FakeRuntime("fused", true);
		const libllama = new FakeRuntime("libllama", true);
		const gate = new DesktopGatedFfiBackendRuntime(
			fused as never,
			libllama as never,
		);
		await expect(gate.release()).resolves.toBeUndefined();
	});
});

describe("resolveFusedLibraryPath", () => {
	afterEach(() => {
		delete process.env.ELIZA_INFERENCE_LIBRARY;
		delete process.env.ELIZA_INFERENCE_LIB_DIR;
	});

	it("returns null when no candidate exists on disk", () => {
		expect(
			resolveFusedLibraryPath("/nonexistent/bundle", {
				ELIZA_INFERENCE_LIBRARY: "/nope/libelizainference.so",
			}),
		).toBeNull();
	});

	it("honors an explicit ELIZA_INFERENCE_LIBRARY when the file exists", () => {
		// Resolve to this test file itself — any existing path proves the
		// explicit-path branch wins.
		const self = new URL(import.meta.url).pathname;
		expect(
			resolveFusedLibraryPath(null, { ELIZA_INFERENCE_LIBRARY: self }),
		).toBe(self);
	});
});
