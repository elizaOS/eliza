/** Verifies the fused-lib FFI backend frees the native library exactly once during acquire/release, with the bindings module mocked so no real lib is dlopened. */
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendPlan } from "./backend";
import {
	type FfiBackendRuntime,
	type FfiBackendSession,
	FfiStreamingBackend,
} from "./ffi-streaming-backend";

// Hoisted spy shared between the mock factory (hoisted) and the test so we can
// assert the fused lib's native free was attempted exactly once.
const ffiCloseMock = vi.hoisted(() =>
	vi.fn(() => {
		throw new Error("ov_free segfault surrogate");
	}),
);

// Replace the fused-lib FFI loader so importing the runtime never pulls bun:ffi
// or dlopens a native library. `loadElizaInferenceFfi` is the only value the
// desktop fused runtime imports from the bindings module; the fake exposes the
// v9 surface the runtime touches during acquire()/release().
vi.mock("./voice/ffi-bindings", () => ({
	loadElizaInferenceFfi: vi.fn(() => ({
		create: () => 1n,
		destroy: vi.fn(),
		close: ffiCloseMock,
		tokenizeSupported: () => true,
		tokenize: () => new Int32Array(),
		llmStreamSupported: () => true,
		llmStreamOpen: () => 0n,
		llmStreamPrefill: () => 0,
		llmStreamNext: () => 0,
		llmStreamCancel: () => 0,
		llmStreamClose: () => undefined,
	})),
}));

/**
 * Tests for #14: unload() must await the native release BEFORE nulling the
 * session refs, otherwise a throwing release leaves the backend wedged —
 * session === null while the runtime still holds a live session, so the next
 * load() skips unload(), calls acquire(), and acquire()'s live-session guard
 * throws forever.
 */

const PLAN: BackendPlan = {
	modelPath: "/fake/model.gguf",
} as unknown as BackendPlan;

function fakeSession(): FfiBackendSession {
	return {
		binding: {} as never,
		ctx: {} as never,
		runner: {} as never,
		tokenize: () => new Int32Array(),
		mtp: null,
		draftModelPath: null,
		mmprojPath: null,
	};
}

/**
 * Minimal runtime that mirrors the real acquire/release live-session guard:
 * acquire() throws if a session is already live (exactly like
 * DesktopFusedFfiBackendRuntime). release() can be made to throw to simulate a
 * native bun:ffi free rejecting.
 */
class GuardedRuntime implements FfiBackendRuntime {
	private active = false;
	releaseShouldThrow = false;
	releaseCalls = 0;

	supported(): boolean {
		return true;
	}

	async acquire(): Promise<FfiBackendSession> {
		if (this.active) {
			throw new Error("acquire() called with a live session; release() first");
		}
		this.active = true;
		return fakeSession();
	}

	async release(): Promise<void> {
		this.releaseCalls += 1;
		if (this.releaseShouldThrow) {
			// The runtime still has a live session — a real release that throws
			// mid-free leaves `active` set (the runtime's own finally is what
			// clears it; here we model the throw-before-clear case).
			throw new Error("native free rejected");
		}
		this.active = false;
	}
}

describe("FfiStreamingBackend.unload() ordering (#14)", () => {
	it("nulls session refs even when release() throws", async () => {
		const runtime = new GuardedRuntime();
		const backend = new FfiStreamingBackend(runtime);
		await backend.load(PLAN);
		expect(backend.hasLoadedModel()).toBe(true);

		runtime.releaseShouldThrow = true;
		await expect(backend.unload()).rejects.toThrow("native free rejected");

		// The finally must have cleared our refs despite the throw, so the
		// backend doesn't report a phantom loaded model.
		expect(backend.hasLoadedModel()).toBe(false);
		expect(backend.currentModelPath()).toBeNull();
	});

	it("awaits release before nulling refs (release observed first)", async () => {
		const order: string[] = [];
		const runtime: FfiBackendRuntime = {
			supported: () => true,
			acquire: async () => fakeSession(),
			release: vi.fn(async () => {
				order.push("release");
			}),
		};
		const backend = new FfiStreamingBackend(runtime);
		await backend.load(PLAN);
		await backend.unload();
		// hasLoadedModel reads session, which is nulled only after release.
		order.push(backend.hasLoadedModel() ? "still-loaded" : "cleared");
		expect(order).toEqual(["release", "cleared"]);
	});
});

describe("DesktopFusedFfiBackendRuntime.release() ordering (#14)", () => {
	beforeEach(() => {
		// resolveFusedLibraryPath() returns the first existing candidate; point it
		// at a real file so acquire() resolves a lib path (the FFI loader itself is
		// mocked, so the path's contents are irrelevant).
		process.env.ELIZA_INFERENCE_LIBRARY = fileURLToPath(import.meta.url);
		ffiCloseMock.mockClear();
	});

	afterEach(() => {
		process.env.ELIZA_INFERENCE_LIBRARY = undefined;
	});

	it("clears the active session even when the fused close() throws", async () => {
		const { DesktopFusedFfiBackendRuntime } = await import(
			"./desktop-fused-ffi-backend-runtime"
		);
		const runtime = new DesktopFusedFfiBackendRuntime();
		await runtime.acquire(PLAN);

		// close() throws, but release() must still clear `active` via its finally.
		await expect(runtime.release()).rejects.toThrow(
			"ov_free segfault surrogate",
		);
		expect(ffiCloseMock).toHaveBeenCalledTimes(1);

		// The runtime is not hidden-wedged on the old live-session guard, but it
		// is explicitly poisoned so a new native model is not allocated over a
		// failed cleanup state.
		await expect(runtime.acquire(PLAN)).rejects.toThrow(/restart required/i);
		// Heavy path (dynamic import + FFI acquire/release/acquire): fast in
		// isolation but CPU-starved under the full 2122-test parallel suite, where
		// it brushed the old 20s ceiling (20012ms). Headroom; a true hang still
		// fails well within this bound.
	}, 45_000);
});
