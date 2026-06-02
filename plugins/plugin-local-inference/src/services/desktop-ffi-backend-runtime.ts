/**
 * Desktop production implementation of `FfiBackendRuntime` from
 * `services/ffi-streaming-backend.ts`.
 *
 * Glues the desktop libllama+shim adapter
 * (`services/desktop-llama-adapter.ts`) into the
 * `FfiStreamingBackend` slot in `BackendDispatcher`. When the dispatcher's
 * `decideBackend()` returns `"llama-cpp"` (the kernel-required path),
 * the dispatcher consults `probeFfiActive()` and routes through this
 * runtime when:
 *   - the libllama + shim dylibs are present on disk
 *   - bun:ffi resolves on the current runtime (Bun, not Node)
 *   - the model load succeeds
 *
 * Any of those failing is an actionable runtime error. There is no server
 * fallback for Eliza-1.
 *
 * Lifecycle:
 *   - One adapter per loaded model. `acquire()` builds it; `release()`
 *     tears it down.
 *   - The backend slot in the dispatcher is single-model — switching
 *     models calls `unload()` then `load()` on the active backend.
 *
 * Feature gaps documented in `FFI_BACKEND_WIREUP_PLAN.md`:
 *   - vision describe (mmproj) — not implemented; `dispatcher.describeImage`
 *     throws the actionable "does not implement" error when this runtime
 *     is active.
 *   - slot save/restore — same.
 *   - prewarm — same.
 *   - parallel resize — same.
 *   - speculative decoding — native MTP requires the bundled drafter GGUF
 *     resolved by the active-model coordinator.
 */

import type { BackendPlan } from "./backend";
import {
	type DesktopLlamaAdapter,
	desktopLlamaDylibsPresent,
	loadDesktopLlama,
} from "./desktop-llama-adapter";
import type {
	FfiBackendRuntime,
	FfiBackendSession,
} from "./ffi-streaming-backend";
import { FfiStreamingRunner } from "./ffi-streaming-runner";

interface ActiveSession {
	adapter: DesktopLlamaAdapter;
	session: FfiBackendSession;
}

export class DesktopFfiBackendRuntime implements FfiBackendRuntime {
	private active: ActiveSession | null = null;
	private poisonedError: Error | null = null;

	supported(): boolean {
		// We don't actually try to dlopen here — that would be too eager
		// (every load() call would do it again). Just check disk presence;
		// the dlopen + symbol resolution is `acquire()`'s job and returns
		// null on failure.
		return desktopLlamaDylibsPresent();
	}

	async acquire(plan: BackendPlan): Promise<FfiBackendSession> {
		if (this.poisonedError) {
			throw new Error(
				`[desktop-ffi-runtime] native cleanup previously failed; restart required before acquiring a new session: ${this.poisonedError.message}`,
			);
		}
		if (this.active) {
			throw new Error(
				"[desktop-ffi-runtime] acquire() called with a live session; release() first",
			);
		}
		const result = await loadDesktopLlama({
			modelPath: plan.modelPath,
			contextSize: plan.overrides?.contextSize,
			gpuLayers:
				typeof plan.overrides?.gpuLayers === "number"
					? plan.overrides.gpuLayers
					: undefined,
			cacheTypeK: plan.overrides?.cacheTypeK,
			cacheTypeV: plan.overrides?.cacheTypeV,
			useMmap: plan.overrides?.mmap,
			useMlock: plan.overrides?.mlock,
		});
		if (!result) {
			throw new Error(
				"[desktop-ffi-runtime] loadDesktopLlama returned null — bun:ffi unavailable or dylibs missing. " +
					"Dispatcher should not have routed here; check probeFfiActive().",
			);
		}
		const runner = new FfiStreamingRunner(result.binding, result.ctx);
		const mmprojPath = plan.overrides?.mmprojPath ?? null;
		const session: FfiBackendSession = {
			binding: result.binding,
			ctx: result.ctx,
			runner,
			tokenize: (prompt) => result.adapter.tokenize(prompt),
			mtp: plan.catalog?.runtime?.mtp ?? null,
			draftModelPath: plan.overrides?.draftModelPath ?? null,
			mmprojPath,
		};
		this.active = { adapter: result.adapter, session };
		return session;
	}

	/** Currently-loaded drafter model path, or null when no drafter is attached. */
	loadedDrafterPath(): string | null {
		return this.active?.adapter.loadedDrafterPath() ?? null;
	}

	/** Active parallel slot count (size of the ctx pool). */
	parallelSlots(): number {
		return this.active?.adapter.parallelSlots() ?? 1;
	}

	/** Grow/shrink the ctx pool. No-op when no model is loaded. */
	async resizeParallel(target: number): Promise<boolean> {
		if (!this.active) return false;
		return this.active.adapter.resizeParallel(target);
	}

	/** Vision availability — true when the shim was built with vision. */
	visionSupported(): boolean {
		return this.active?.adapter.visionSupported() ?? false;
	}

	/** Current mmproj path (per the most recent describeImage). */
	currentMmprojPath(): string | null {
		return this.active?.adapter.currentMmprojPath() ?? null;
	}

	/**
	 * Vision describe — load mmproj if needed, embed the image, generate
	 * the description. Throws when no model is loaded OR vision build flag
	 * is off (the adapter surfaces an actionable error in that case).
	 */
	async describeImage(args: {
		imageBytes: Uint8Array;
		mmprojPath: string;
		prompt?: string;
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
	}): Promise<{ text: string; projectorMs?: number; decodeMs?: number }> {
		if (!this.active) {
			throw new Error("[desktop-ffi-runtime] describeImage before load");
		}
		return this.active.adapter.describeImage(args);
	}

	async release(): Promise<void> {
		if (!this.active) return;
		// Clear `active` in a finally so a throwing native free (adapter.close()
		// makes raw bun:ffi calls that can throw) can't leave the runtime with a
		// stale live session that permanently blocks acquire()'s live-session guard.
		// If close reports a best-effort cleanup failure, poison this runtime so
		// callers cannot allocate a new native model over leaked resources.
		try {
			this.active.adapter.close();
		} catch (err) {
			this.poisonedError = err instanceof Error ? err : new Error(String(err));
			throw err;
		} finally {
			this.active = null;
		}
	}
}

/**
 * Convenience singleton — the engine constructs one per process. Multiple
 * loads against the same instance go through acquire/release lifecycles.
 */
export const desktopFfiBackendRuntime = new DesktopFfiBackendRuntime();
