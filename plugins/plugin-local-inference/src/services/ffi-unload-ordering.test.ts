import { describe, expect, it, vi } from "vitest";
import type { BackendPlan } from "./backend";
import {
	type FfiBackendRuntime,
	type FfiBackendSession,
	FfiStreamingBackend,
} from "./ffi-streaming-backend";

// Hoisted spy so the mock factory (also hoisted) and the test can share it.
const adapterMock = vi.hoisted(() => ({
	close: vi.fn(() => {
		throw new Error("llama_backend_free segfault surrogate");
	}),
}));

// Replace the FFI adapter module entirely so importing it never pulls bun:ffi
// or dlopens a native library. desktop-ffi-backend-runtime.ts only value-imports
// `loadDesktopLlama` + `desktopLlamaDylibsPresent`, so those are the only fakes.
vi.mock("./desktop-llama-adapter", () => ({
	desktopLlamaDylibsPresent: () => true,
	loadDesktopLlama: vi.fn(async () => ({
		binding: {},
		ctx: {},
		adapter: {
			close: adapterMock.close,
			tokenize: () => new Int32Array(),
			loadedDrafterPath: () => null,
			parallelSlots: () => 1,
		},
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
 * DesktopFfiBackendRuntime). release() can be made to throw to simulate a
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

describe("DesktopFfiBackendRuntime.release() ordering (#14)", () => {
	it("clears the active session even when adapter.close() throws", async () => {
		const { DesktopFfiBackendRuntime } = await import(
			"./desktop-ffi-backend-runtime"
		);
		const runtime = new DesktopFfiBackendRuntime();
		await runtime.acquire(PLAN);

		// close() throws, but release() must still clear `active` via its finally.
		await expect(runtime.release()).rejects.toThrow(
			"llama_backend_free segfault surrogate",
		);
		expect(adapterMock.close).toHaveBeenCalledTimes(1);

		// The runtime is not hidden-wedged on the old live-session guard, but it
		// is explicitly poisoned so a new native model is not allocated over a
		// failed cleanup state.
		await expect(runtime.acquire(PLAN)).rejects.toThrow(/restart required/i);
	});
});
