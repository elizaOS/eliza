/**
 * NVIDIA GPU detection + profile mapping.
 *
 * Wraps `nvidia-smi` to identify the host GPU and maps it to a
 * `GpuProfileId` from `@elizaos/plugin-native-inference/model-catalog/gpu-profiles`.
 *
 * Single-GPU only: when multiple GPUs are present, we use the first one
 * `nvidia-smi` reports (canonical CUDA device 0). We do NOT try to split
 * the model across multiple cards — that is an explicit non-goal of the
 * single-GPU profile system.
 *
 * Detection is cached after first call. Pass `force: true` to bypass the
 * cache when a fresh probe is needed (e.g. after a GPU hot-swap on a
 * laptop dock — unusual but possible).
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { GPU_PROFILES, type GpuProfile, type GpuProfileId, matchGpuProfile } from "@elizaos/plugin-native-inference/model-catalog/gpu-profiles";

export interface DetectedGpu {
	/** Raw GPU name from `nvidia-smi --query-gpu=name`. */
	name: string;
	/** Total VRAM in MiB as reported by `nvidia-smi`. */
	totalMemoryMiB: number;
	/** Matched profile id, or `null` when the card is not in the supported set. */
	profileId: GpuProfileId | null;
}

export interface GpuDetectionResult {
	/** `true` when `nvidia-smi` ran successfully (even if no GPU matched a profile). */
	nvidiaPresent: boolean;
	/** First GPU reported by `nvidia-smi`; `null` when no NVIDIA GPU is present. */
	gpu: DetectedGpu | null;
	/** Resolved profile, or `null` for unsupported / non-NVIDIA hosts. */
	profile: GpuProfile | null;
}

const EMPTY_RESULT: GpuDetectionResult = {
	nvidiaPresent: false,
	gpu: null,
	profile: null,
};

let cached: GpuDetectionResult | null = null;
let spawnSyncForTests:
	| ((
			command: string,
			args: string[],
			options: Parameters<typeof spawnSync>[2],
	  ) => SpawnSyncReturns<string>)
	| null = null;

/**
 * Detect the primary NVIDIA GPU and resolve it to a profile. Returns
 * `{ nvidiaPresent: false }` on hosts without `nvidia-smi` on PATH or
 * without an NVIDIA GPU.
 *
 * The probe runs `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`
 * with a 3-second timeout so a misbehaving driver cannot stall boot. When the
 * first call is killed by that timeout, the probe retries once with an
 * extended deadline: on RTD3 laptops (GPU runtime-suspended to D3cold) the
 * first `nvidia-smi` after GPU sleep must cold-wake the card, which can take
 * longer than 3 s. Without the retry the boot-time probe would report
 * `gpu: null`, cache it, and wrongly demote embeddings to the CPU tier for
 * the process lifetime. The killed first invocation already initiated the
 * kernel's runtime-resume, so the retry normally answers quickly.
 *
 * A probe that fails FAST with a nonzero exit is NOT retried — that is a real
 * "no usable GPU" answer. Observed on an RTX 5080 Laptop whose driver entered
 * runtime-PM `error` state after a failed suspend (GSP unload timeout under
 * host RAM pressure, issue #11339): `nvidia-smi` exits 6 immediately and the
 * probe correctly degrades embedding selection to the CPU tier.
 */
export function detectGpu(opts: { force?: boolean } = {}): GpuDetectionResult {
	if (cached && !opts.force) return cached;
	cached = probe();
	return cached;
}

/** Clear the cached detection result. Used by tests. */
export function __resetGpuDetectionCacheForTests(): void {
	cached = null;
	spawnSyncForTests = null;
}

/** Override the nvidia-smi runner. Used by tests without mutating ESM exports. */
export function __setGpuDetectionSpawnSyncForTests(
	runner:
		| ((
				command: string,
				args: string[],
				options: Parameters<typeof spawnSync>[2],
		  ) => SpawnSyncReturns<string>)
		| null,
): void {
	spawnSyncForTests = runner;
}

const PROBE_TIMEOUT_MS = 3_000;
/**
 * Deadline for the single retry after a timed-out first call. RTD3 cold wake
 * usually completes within a few seconds once the resume is in flight; 15 s
 * gives headroom for a memory-pressured host without letting a truly hung
 * driver stall boot indefinitely (worst case 3 s + 15 s, once per process —
 * the result is cached).
 */
const COLD_WAKE_RETRY_TIMEOUT_MS = 15_000;

const NVIDIA_SMI_ARGS = [
	"--query-gpu=name,memory.total",
	"--format=csv,noheader,nounits",
];

function runNvidiaSmi(timeoutMs: number): SpawnSyncReturns<string> {
	if (spawnSyncForTests) {
		return spawnSyncForTests("nvidia-smi", NVIDIA_SMI_ARGS, {
			encoding: "utf8",
			timeout: timeoutMs,
			stdio: ["ignore", "pipe", "pipe"],
		});
	}
	return spawnSync("nvidia-smi", NVIDIA_SMI_ARGS, {
		encoding: "utf8",
		timeout: timeoutMs,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * `true` when the spawn was killed by its own timeout. Both Node and Bun
 * report a `spawnSync` timeout as `error.code === "ETIMEDOUT"` (verified on
 * Node 25.2 and Bun 1.4). A missing binary (ENOENT) or a completed run with
 * a failure exit code is not a timeout and must not be retried.
 */
function wasKilledByTimeout(result: SpawnSyncReturns<string>): boolean {
	const { error } = result;
	return error !== undefined && "code" in error && error.code === "ETIMEDOUT";
}

function probe(): GpuDetectionResult {
	let result = runNvidiaSmi(PROBE_TIMEOUT_MS);
	if (wasKilledByTimeout(result)) {
		// RTD3 cold wake: the first call woke the GPU but was killed before the
		// driver answered. Retry once — the wake is already in progress.
		result = runNvidiaSmi(COLD_WAKE_RETRY_TIMEOUT_MS);
	}
	if (result.error || result.status !== 0) {
		return EMPTY_RESULT;
	}
	const stdout =
		typeof result.stdout === "string"
			? result.stdout
			: String(result.stdout ?? "");
	const firstLine = stdout
		.split(/\r?\n/)
		.find((line: string) => line.trim() !== "");
	if (!firstLine) return EMPTY_RESULT;

	// Format: "NVIDIA H200, 141248"
	const parts = firstLine.split(",").map((part: string) => part.trim());
	if (parts.length < 2) return EMPTY_RESULT;
	const name = parts[0] ?? "";
	const memMiBRaw = Number.parseInt(parts[1] ?? "", 10);
	const totalMemoryMiB = Number.isFinite(memMiBRaw) ? memMiBRaw : 0;

	const profileId = matchGpuProfile(name);
	const profile = profileId ? GPU_PROFILES[profileId] : null;

	return {
		nvidiaPresent: true,
		gpu: { name, totalMemoryMiB, profileId },
		profile,
	};
}

/**
 * Recommend a `GpuProfileId` for a synthetic GPU descriptor — used by the
 * recommender service when it already has a `HardwareProbe` and does not
 * want to re-shell out to `nvidia-smi`. Returns `null` when nothing
 * matches.
 */
export function recommendProfileFromName(name: string): GpuProfileId | null {
	return matchGpuProfile(name);
}
