/**
 * GPU-OOM memory admission for the mobile Capacitor-llama load path (#11612).
 *
 * Why this exists — measured on iPhone 16 Pro Max (A18, 8 GiB physical RAM):
 *
 *   weights (Metal, full 36-layer offload) : 4722 MiB
 *   compute buffer (default n_ubatch=1024) : 1037 MiB
 *   KV cache (swa_full=false, 128k SWA)    :   36 MiB
 *   ------------------------------------------------
 *   total                                  ≈ 5795 MiB
 *
 * iOS grants a foreground process ≈ 2/3 of physical RAM before jetsam
 * (`os_proc_available_memory()` on a fresh 8 GiB A18 reports ~5461 MiB
 * = 8192 × 2/3). 5795 > 5461 → Metal returns ret=-3 mid-decode and the
 * process is jetsammed with the ~4.7 GiB of wired weights still mapped.
 *
 * Two-part fix, gated to constrained mobile (`ELIZA_PLATFORM=ios|android`)
 * only — desktop keeps binding defaults and full offload:
 *
 *   1. Shrink the micro-batch: `n_ubatch=256` (with `n_batch=256`, llama.cpp
 *      requires n_ubatch ≤ n_batch). Compute buffer scales ~linearly with
 *      n_ubatch: 1037 × (256/1024) ≈ 260 MiB, so
 *      4722 + 260 + 36 ≈ 5018 MiB < 5461 MiB — full-GPU speed retained.
 *   2. Admission guard: if (weights + compute + KV) still exceeds the
 *      working-set budget, reduce `n_gpu_layers` so only the fitting
 *      fraction of layers is Metal-wired. CPU-resident layers stay
 *      mmap-backed *clean* pages (evictable, not counted against the jetsam
 *      footprint the way wired Metal buffers are), so lowering
 *      `n_gpu_layers` genuinely lowers the fatal footprint.
 *
 * The JS runtime on device cannot call `os_proc_available_memory()`
 * directly (no binding export), so the budget derives from physical RAM
 * (`os.totalmem()`) × the empirical 2/3 iOS working-set fraction. Android's
 * low-memory-killer budget is comparable in practice, and this path only
 * runs on `ELIZA_PLATFORM=ios|android`.
 */

import fs from "node:fs";
import os from "node:os";
import { logger } from "@elizaos/core";
import { loadCapacitorLlamaModelInfo } from "./loader";

const MIB = 1024 * 1024;

/** Micro-batch for constrained-mobile loads (see fit math above). */
export const MOBILE_N_UBATCH = 256;

/**
 * Compute-buffer cost per n_ubatch element: 1037 MiB measured at
 * n_ubatch=1024 (eliza-1-4b on A18) → ≈1.013 MiB per element.
 */
const COMPUTE_MIB_PER_UBATCH = 1037 / 1024;

/**
 * KV-cache allowance. Measured 36 MiB with `swa_full=false` on the mostly
 * sliding-window eliza-1 attention stack; 64 MiB leaves slack for the
 * non-SWA global layers growing with context.
 */
const KV_MIB = 64;

/** Layer count fallback when GGUF metadata is unreachable (eliza-1-4b = 36). */
const DEFAULT_LAYER_COUNT = 36;

/** Fill at most this fraction of the working-set budget (mmap/runtime slack). */
const ADMISSION_SAFETY = 0.97;

/** iOS jetsam working-set fraction of physical RAM (8192 MiB → ~5461 MiB). */
const MOBILE_WORKING_SET_FRACTION = 2 / 3;

/** True on the constrained-mobile platforms this admission logic targets. */
export function isConstrainedMobilePlatform(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const platform = env.ELIZA_PLATFORM?.trim().toLowerCase();
	return platform === "android" || platform === "ios";
}

/** Thrown when not even a zero-offload load fits the working-set budget. */
export class MobileMemoryAdmissionError extends Error {
	constructor(readonly admission: MobileGpuAdmission) {
		super(
			`[capacitor-llama] Model does not fit the mobile working-set budget: ` +
				`weights ${admission.weightsMib} MiB + compute ${admission.computeMib} MiB ` +
				`+ KV ${admission.kvMib} MiB exceeds budget ${admission.budgetMib} MiB ` +
				`even at n_gpu_layers=0. Refusing to load (would be jetsammed).`,
		);
		this.name = "MobileMemoryAdmissionError";
	}
}

export interface MobileGpuAdmission {
	/** 999 = full offload (llama.cpp convention), else the fitting layer count. */
	nGpuLayers: number;
	nBatch: number;
	nUbatch: number;
	/** Per-process working-set budget (MiB). */
	budgetMib: number;
	weightsMib: number;
	computeMib: number;
	kvMib: number;
	layerCount: number;
	fullOffload: boolean;
}

/**
 * Pure fit computation — exported for tests. Throws
 * `MobileMemoryAdmissionError` when nothing fits.
 */
export function planMobileGpuAdmission(input: {
	weightsBytes: number;
	layerCount?: number | null;
	totalRamBytes?: number;
}): MobileGpuAdmission {
	const totalRamBytes = input.totalRamBytes ?? os.totalmem();
	const budgetMib = Math.floor(
		(totalRamBytes / MIB) * MOBILE_WORKING_SET_FRACTION,
	);
	const weightsMib = Math.ceil(input.weightsBytes / MIB);
	const computeMib = Math.ceil(COMPUTE_MIB_PER_UBATCH * MOBILE_N_UBATCH);
	const layerCount =
		input.layerCount && input.layerCount > 0
			? input.layerCount
			: DEFAULT_LAYER_COUNT;
	// MiB of weights the GPU may wire after compute + KV are reserved.
	const usableForWeightsMib =
		Math.floor(budgetMib * ADMISSION_SAFETY) - computeMib - KV_MIB;

	const base = {
		nBatch: MOBILE_N_UBATCH,
		nUbatch: MOBILE_N_UBATCH,
		budgetMib,
		weightsMib,
		computeMib,
		kvMib: KV_MIB,
		layerCount,
	};

	if (weightsMib <= usableForWeightsMib) {
		return { ...base, nGpuLayers: 999, fullOffload: true };
	}
	if (usableForWeightsMib <= 0) {
		throw new MobileMemoryAdmissionError({
			...base,
			nGpuLayers: 0,
			fullOffload: false,
		});
	}
	// Partial offload: wire only the fitting fraction of layers.
	const perLayerMib = weightsMib / layerCount;
	const nGpuLayers = Math.min(
		layerCount,
		Math.floor(usableForWeightsMib / perLayerMib),
	);
	return { ...base, nGpuLayers, fullOffload: false };
}

/** Extract `<arch>.block_count` from GGUF metadata, else null. */
export function extractLayerCount(
	metadata: Record<string, unknown> | null,
): number | null {
	if (!metadata) return null;
	for (const [key, value] of Object.entries(metadata)) {
		if (!key.endsWith(".block_count")) continue;
		const parsed = typeof value === "string" ? Number(value) : value;
		if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
			return Math.floor(parsed);
		}
	}
	return null;
}

/**
 * Resolve the admission plan for a model file on constrained mobile.
 * Returns `null` off-mobile (desktop keeps binding defaults + full offload).
 */
export async function resolveMobileGpuAdmission(
	modelPath: string,
): Promise<MobileGpuAdmission | null> {
	if (!isConstrainedMobilePlatform()) return null;
	const weightsBytes = fs.statSync(modelPath).size;
	const metadata = await loadCapacitorLlamaModelInfo(modelPath);
	const admission = planMobileGpuAdmission({
		weightsBytes,
		layerCount: extractLayerCount(metadata),
	});
	logger.info(
		{
			modelPath,
			...admission,
			fitMib: admission.weightsMib + admission.computeMib + admission.kvMib,
		},
		"[capacitor-llama] Mobile GPU memory admission",
	);
	return admission;
}
