/**
 * Desktop production implementation of `FfiBackendRuntime` from
 * `services/ffi-streaming-backend.ts`.
 *
 * Glues the desktop libllama+shim adapter
 * (`services/desktop-llama-adapter.ts`) into the
 * `FfiStreamingBackend` slot in `BackendDispatcher`. When the dispatcher's
 * `decideBackend()` returns `"llama-server"` (the kernel-required path),
 * the dispatcher now consults `probeFfiActive()` and routes through this
 * runtime when:
 *   - the libllama + shim dylibs are present on disk
 *   - bun:ffi resolves on the current runtime (Bun, not Node)
 *   - the model load succeeds
 *
 * Any of those failing => `acquire()` returns null and the dispatcher
 * falls through to the subprocess `dflashLlamaServer`.
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
 *   - speculative decoding — silently ignored (warning logged once).
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

	supported(): boolean {
		// We don't actually try to dlopen here — that would be too eager
		// (every load() call would do it again). Just check disk presence;
		// the dlopen + symbol resolution is `acquire()`'s job and returns
		// null on failure.
		return desktopLlamaDylibsPresent();
	}

	async acquire(plan: BackendPlan): Promise<FfiBackendSession> {
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
			useMmap: plan.overrides?.mmap,
			useMlock: plan.overrides?.mlock,
		});
		if (!result) {
			throw new Error(
				"[desktop-ffi-runtime] loadDesktopLlama returned null — bun:ffi unavailable or dylibs missing. " +
					"Dispatcher should not have routed here; check probeFfiActive().",
			);
		}
		// Speculative decoding: the catalog entry may declare a drafter
		// GGUF via `runtime.dflash.drafterModelPath`. The adapter loads +
		// attaches it lazily when the first `llmStreamOpen` runs with a
		// non-null `dflashDrafterPath`. We surface the resolved path on
		// the session so `FfiStreamingBackend.generate()` can pass it
		// through to the runner.
		const drafterPath = resolveDrafterPath(plan);
		const runner = new FfiStreamingRunner(result.binding, result.ctx);
		const session: FfiBackendSession = {
			binding: result.binding,
			ctx: result.ctx,
			runner,
			tokenize: (prompt) => result.adapter.tokenize(prompt),
			drafterPath,
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

	async release(): Promise<void> {
		if (!this.active) return;
		this.active.adapter.close();
		this.active = null;
	}
}

/**
 * Convenience singleton — the engine constructs one per process. Multiple
 * loads against the same instance go through acquire/release lifecycles.
 */
export const desktopFfiBackendRuntime = new DesktopFfiBackendRuntime();

/**
 * Resolve a DFlash drafter GGUF path from the plan. The dispatcher's
 * subprocess path reads the drafter from `catalog.runtime.dflash` (see
 * `dflash-server.ts`'s catalog handling); we mirror that here so FFI
 * mode runs speculative decoding against the same drafter. Returns null
 * when the catalog doesn't declare one (drafter-less generation).
 */
function resolveDrafterPath(plan: BackendPlan): string | null {
	const dflash = plan.catalog?.runtime?.dflash;
	if (!dflash || typeof dflash !== "object") return null;
	const path =
		(dflash as { drafterModelPath?: unknown }).drafterModelPath ??
		(dflash as { drafterPath?: unknown }).drafterPath;
	return typeof path === "string" && path.length > 0 ? path : null;
}
