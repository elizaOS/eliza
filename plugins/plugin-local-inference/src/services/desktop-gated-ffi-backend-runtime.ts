/**
 * Gate between the FUSED `libelizainference` text runtime and the libllama
 * text runtime for the desktop FFI backend slot.
 *
 * The dispatcher's `decideBackend()` (backend.ts) decides WHETHER to use the
 * in-process llama.cpp path (`"llama-cpp"`); this gate decides WHICH native
 * library serves it. The rule (Phase 2 of the fused-lib migration):
 *
 *   - Prefer the fused runtime when its ABI-v8 capability probes pass
 *     (`llmStreamSupported && llmMtpSupported && llmKvQuantSupported`) so text
 *     generation runs through the same fused lib as voice (one lib, one GGML
 *     pin, one resident text model) WITH same-file MTP + KV-cache quant.
 *   - A fused lib that lacks those optimizations (a v7 build, or no fused lib on
 *     disk) is REFUSED → fall back to the libllama runtime, which has the
 *     optimizations through the shim. We never fall through to an unoptimized
 *     fused loop.
 *   - Vision describe prefers the fused runtime when the fused lib was built
 *     with vision (ABI v9 `eliza_inference_describe_image`, reusing the mtmd
 *     machinery already linked for ASR), so text + vision share one lib. When
 *     a load needs vision (`overrides.mmprojPath` is set) but the fused lib has
 *     no vision symbol, the gate routes the whole session to libllama so the
 *     mtmd vision-describe path keeps working exactly as before. Text-only
 *     loads prefer the fused runtime.
 *
 * The gate binds one runtime per acquire and forwards every subsequent call
 * (`release`, `parallelSlots`, `resizeParallel`, `describeImage`, …) to it.
 */

import type { BackendPlan } from "./backend";
import {
	type DesktopFfiBackendRuntime,
	desktopFfiBackendRuntime,
} from "./desktop-ffi-backend-runtime";
import {
	type DesktopFusedFfiBackendRuntime,
	desktopFusedFfiBackendRuntime,
} from "./desktop-fused-ffi-backend-runtime";
import type {
	FfiBackendRuntime,
	FfiBackendSession,
} from "./ffi-streaming-backend";

export class DesktopGatedFfiBackendRuntime implements FfiBackendRuntime {
	/** The runtime bound by the most recent `acquire()`; null between sessions. */
	private bound: FfiBackendRuntime | null = null;

	constructor(
		private readonly fused: DesktopFusedFfiBackendRuntime,
		private readonly libllama: DesktopFfiBackendRuntime,
	) {}

	/**
	 * The FFI backend is usable when EITHER runtime is usable. The libllama
	 * runtime is the floor (it carries the optimizations through the shim); the
	 * fused runtime is preferred when its v8 probes pass.
	 */
	supported(): boolean {
		return this.fused.supported() || this.libllama.supported();
	}

	/**
	 * True when the fused runtime is the one this gate would pick for a
	 * text-only load. Diagnostic — the engine logs which native lib serves text.
	 */
	fusedPreferred(): boolean {
		return this.fused.supported();
	}

	/**
	 * Pick the runtime for THIS load:
	 *   - text-only load → prefer fused when its v8 probes pass, else libllama.
	 *   - vision load (mmproj present) → fused when the fused lib was built with
	 *     vision (ABI v9 `eliza_inference_describe_image`) AND its text probes
	 *     pass, so text + vision share one lib; else libllama (the libllama mtmd
	 *     path stays as the guarded fallback — no regression).
	 */
	private pick(plan: BackendPlan): FfiBackendRuntime {
		const needsVision = Boolean(plan.overrides?.mmprojPath);
		if (!this.fused.supported()) return this.libllama;
		if (needsVision && !this.fused.visionSupportedStatic()) return this.libllama;
		return this.fused;
	}

	async acquire(plan: BackendPlan): Promise<FfiBackendSession> {
		if (this.bound) {
			throw new Error(
				"[desktop-gated-ffi-runtime] acquire() called with a live session; release() first",
			);
		}
		const runtime = this.pick(plan);
		const session = await runtime.acquire(plan);
		this.bound = runtime;
		return session;
	}

	async release(): Promise<void> {
		const runtime = this.bound;
		this.bound = null;
		if (runtime) await runtime.release();
	}

	parallelSlots(): number {
		return this.bound?.parallelSlots?.() ?? 1;
	}

	async resizeParallel(target: number): Promise<boolean> {
		if (!this.bound?.resizeParallel) return false;
		return this.bound.resizeParallel(target);
	}

	// Vision-describe surface. Both runtimes can implement it now: the fused
	// runtime via `eliza_inference_describe_image` (ABI v9, preferred for vision
	// loads when the lib was built with vision), the libllama runtime via its
	// mtmd path (the guarded fallback). Forwarded through the bound runtime;
	// when the bound runtime lacks vision (a text-only fused session) this
	// throws, and `canDescribeImages()` is already false for that session.
	async describeImage(args: {
		imageBytes: Uint8Array;
		mmprojPath: string;
		prompt?: string;
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
	}): Promise<{ text: string; projectorMs?: number; decodeMs?: number }> {
		const runtime = this.bound as unknown as {
			describeImage?: (a: typeof args) => Promise<{
				text: string;
				projectorMs?: number;
				decodeMs?: number;
			}>;
		} | null;
		if (!runtime?.describeImage) {
			throw new Error(
				"[desktop-gated-ffi-runtime] bound runtime lacks describeImage support " +
					"(vision-describe stays on the libllama runtime; this load is text-only on the fused lib)",
			);
		}
		return runtime.describeImage(args);
	}

	visionSupported(): boolean {
		const runtime = this.bound as unknown as {
			visionSupported?: () => boolean;
		} | null;
		return runtime?.visionSupported?.() ?? false;
	}

	currentMmprojPath(): string | null {
		const runtime = this.bound as unknown as {
			currentMmprojPath?: () => string | null;
		} | null;
		return runtime?.currentMmprojPath?.() ?? null;
	}

	loadedDrafterPath(): string | null {
		const runtime = this.bound as unknown as {
			loadedDrafterPath?: () => string | null;
		} | null;
		return runtime?.loadedDrafterPath?.() ?? null;
	}
}

/**
 * Process singleton wiring the fused + libllama runtimes behind the gate. The
 * engine uses this as the single `FfiBackendRuntime` for the dispatcher's
 * `"llama-cpp"` slot.
 */
export const desktopGatedFfiBackendRuntime = new DesktopGatedFfiBackendRuntime(
	desktopFusedFfiBackendRuntime,
	desktopFfiBackendRuntime,
);
