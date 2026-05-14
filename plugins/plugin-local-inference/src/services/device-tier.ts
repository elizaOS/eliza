/**
 * Device-tier classifier — maps a `HardwareProbe` to a `DeviceTier`
 * (`MAX | GOOD | OKAY | POOR`) and produces the warning copy + the
 * recommended local-voice policy the runtime + UI consume.
 *
 * Single-pass classifier (no async I/O). The host probe already happened in
 * `hardware.ts`; this module is pure arithmetic on top of the probe.
 *
 * Numeric thresholds and tier definitions are sourced verbatim from R9
 * (`.swarm/research/R9-memory.md` §3.1) — keep this file's per-tier table
 * in sync with that document.
 *
 *   - **MAX** — all voice + LM models can be **parallelized** and held
 *     resident at once (~24 GB effective model RAM AND ≥ 16 GB free at
 *     session start AND a dGPU with ≥ 16 GB VRAM OR an Apple Silicon
 *     Pro/Max/Ultra with ≥ 32 GB unified RAM).
 *   - **GOOD** — all models can be loaded into memory and run, but
 *     serialized (~12 GB effective model RAM AND ≥ 8 GB free at session
 *     start AND a dGPU with ≥ 8 GB VRAM, OR Apple Silicon base ≥ 16 GB,
 *     OR x86 CPU-only ≥ 32 GB).
 *   - **OKAY** — models load and unload per turn; caching breaks across
 *     swaps (~6 GB effective model RAM AND ≥ 3 GB free).
 *   - **POOR** — severe issues; refuse local voice, recommend cloud.
 *
 * Mobile clamps to **OKAY** at best regardless of RAM because the OS
 * background-task model breaks long-running local inference (iOS jetsam
 * 3–4 GB ceiling; Android foreground-service requirement).
 */

import type { HardwareProbe } from "./types";

/** The four device tiers used by the runtime + UI. */
export type DeviceTier = "MAX" | "GOOD" | "OKAY" | "POOR";

/** Tier ordering (higher index = better device). */
export const DEVICE_TIER_ORDER: ReadonlyArray<DeviceTier> = [
	"POOR",
	"OKAY",
	"GOOD",
	"MAX",
];

/**
 * Numeric thresholds. R9 §3.1 — keep in sync.
 *
 * "Effective model memory" is the memory the model can actually use, in GB.
 * The math mirrors `recommendation.ts:effectiveMemoryGb()`:
 *   - Apple Silicon: `totalRamGb`.
 *   - Discrete GPU: `max(gpu.totalVramGb, totalRamGb * 0.5)`.
 *   - CPU-only:     `totalRamGb * 0.5`.
 */
export const DEVICE_TIER_THRESHOLDS = {
	MAX: {
		effectiveModelMemoryGb: 24,
		freeRamGbAtSession: 16,
		dGpuMinVramGb: 16,
		appleSiliconMinUnifiedGb: 32,
	},
	GOOD: {
		effectiveModelMemoryGb: 12,
		freeRamGbAtSession: 8,
		dGpuMinVramGb: 8,
		appleSiliconMinUnifiedGb: 16,
		x86CpuOnlyMinTotalGb: 32,
	},
	OKAY: {
		effectiveModelMemoryGb: 6,
		freeRamGbAtSession: 3,
		minTotalRamGb: 16,
		mobileMinTotalRamGb: 12,
	},
} as const;

/** What the runtime should do by default given the tier classification. */
export type RecommendedMode = "local" | "cloud-with-local-voice" | "cloud-only";

/** A complete tier assessment — what the UI renders + what the runtime gates on. */
export interface DeviceTierAssessment {
	tier: DeviceTier;
	/** Human-readable reasons for the decision. */
	reasons: string[];
	/** The top recommendation for the user, in plain text. */
	topRecommendation: string;
	/** True when local LM (eliza-1) is viable at the user's tier. */
	canRunLocalLm: boolean;
	/** True when the local voice stack (ASR + TTS) is viable. */
	canRunLocalVoice: boolean;
	/** Default backend mode for the user. */
	recommendedMode: RecommendedMode;
	/** Numeric snapshot to drive UI badges and onboarding copy. */
	numericContext: {
		totalRamGb: number;
		freeRamGb: number;
		effectiveModelMemoryGb: number;
		vramGb: number | null;
		cpuCores: number;
		appleSilicon: boolean;
		mobile: boolean;
	};
}

const MB_PER_GB = 1024;

/**
 * Compute the memory the model can actually use, in GB. Apple Silicon uses
 * unified memory; discrete-GPU x86 weights VRAM; CPU-only halves total RAM.
 * Mirrors `recommendation.ts:effectiveMemoryGb`.
 */
export function effectiveModelMemoryGb(probe: HardwareProbe): number {
	if (probe.appleSilicon) return probe.totalRamGb;
	if (probe.gpu) {
		return Math.max(probe.gpu.totalVramGb, probe.totalRamGb * 0.5);
	}
	return probe.totalRamGb * 0.5;
}

/**
 * Treat the host as a mobile device. Mobile clamps to OKAY at best
 * regardless of RAM because the OS background-task model breaks
 * long-running local inference.
 */
function isMobile(probe: HardwareProbe): boolean {
	return (
		probe.mobile?.platform === "ios" || probe.mobile?.platform === "android"
	);
}

/**
 * Compute the AVX2 baseline. The hardware probe has no direct AVX2 field
 * today — assume modern Apple Silicon (no AVX, but has Neon) and any
 * Linux/Win x86_64 ≥ 4 cores qualifies. CPU < 4 cores fails.
 *
 * This is a coarse heuristic; the precise check belongs in the FFI layer
 * (it can `cpuid` the actual flags). The tier classifier just refuses POOR
 * when the probe is clearly under-equipped.
 */
function hasAvx2Baseline(probe: HardwareProbe): boolean {
	if (probe.appleSilicon) return true; // M-series Neon is the equivalent baseline.
	if (probe.arch !== "x64" && probe.arch !== "arm64") return false;
	return probe.cpuCores >= 4;
}

/**
 * The free-RAM gate at session start. R9 §3.3: only a *secondary* gate that
 * can demote a device by one tier when `freeRamGb < totalRamGb * 0.25`.
 * Never promotes.
 */
function freeRamDemotion(probe: HardwareProbe): boolean {
	return probe.freeRamGb < probe.totalRamGb * 0.25;
}

/** Apple-silicon 8 GB clamp. R9 §3.4: hard ceiling at OKAY. */
function isAppleSilicon8gb(probe: HardwareProbe): boolean {
	return probe.appleSilicon && probe.totalRamGb <= 9; // 8 GB rounded.
}

/**
 * The single-pass classifier. Returns a complete assessment including the
 * tier, the reasons, the recommended default mode, and the numeric context
 * the UI needs to render the badge.
 *
 * The classifier is pure: same input → same output, no I/O, no clock.
 */
export function classifyDeviceTier(probe: HardwareProbe): DeviceTierAssessment {
	const reasons: string[] = [];
	const effective = effectiveModelMemoryGb(probe);
	const mobile = isMobile(probe);
	const avx2 = hasAvx2Baseline(probe);
	const vramGb = probe.gpu?.totalVramGb ?? null;
	const cpuCores = probe.cpuCores;
	const totalRamGb = probe.totalRamGb;
	const freeRamGb = probe.freeRamGb;

	let tier: DeviceTier = classifyRawTier({
		probe,
		effective,
		avx2,
		mobile,
		reasons,
	});

	// Apple Silicon 8 GB clamp — never higher than OKAY.
	if (isAppleSilicon8gb(probe) && tierRank(tier) > tierRank("OKAY")) {
		reasons.push("Apple Silicon 8 GB models clamp to OKAY");
		tier = "OKAY";
	}

	// Mobile clamp — at best OKAY regardless of RAM (iOS jetsam, Android
	// foreground-service cost). R9 §6.
	if (mobile && tierRank(tier) > tierRank("OKAY")) {
		reasons.push(
			probe.mobile?.platform === "ios"
				? "iOS clamps to OKAY (jetsam ~3-4 GB ceiling, background-audio only)"
				: "Android clamps to OKAY (foreground-service required for continuous mic)",
		);
		tier = "OKAY";
	}

	// Free-RAM gate at session start — secondary demotion only.
	if (freeRamDemotion(probe) && tierRank(tier) > tierRank("POOR")) {
		reasons.push(
			`Low free RAM at session start: ${freeRamGb.toFixed(1)} GB free / ${totalRamGb.toFixed(1)} GB total — demoting one tier`,
		);
		tier = previousTier(tier);
	}

	const canRunLocalLm = tier !== "POOR";
	const canRunLocalVoice = tier === "MAX" || tier === "GOOD";
	let recommendedMode: RecommendedMode;
	if (tier === "MAX" || tier === "GOOD") recommendedMode = "local";
	else if (tier === "OKAY")
		recommendedMode = mobile ? "cloud-with-local-voice" : "local";
	else recommendedMode = "cloud-only";

	if (mobile && tier !== "POOR") {
		// On mobile we default to cloud TTS+ASR per R9 §6.3; only turn-detector
		// + VAD + wake-word run locally by default.
		recommendedMode = "cloud-with-local-voice";
	}

	const topRecommendation = topRecommendationFor(tier, mobile);

	return {
		tier,
		reasons,
		topRecommendation,
		canRunLocalLm,
		canRunLocalVoice,
		recommendedMode,
		numericContext: {
			totalRamGb,
			freeRamGb,
			effectiveModelMemoryGb: effective,
			vramGb,
			cpuCores,
			appleSilicon: probe.appleSilicon,
			mobile,
		},
	};
}

interface ClassifyArgs {
	probe: HardwareProbe;
	effective: number;
	avx2: boolean;
	mobile: boolean;
	reasons: string[];
}

function classifyRawTier(args: ClassifyArgs): DeviceTier {
	const { probe, effective, avx2, mobile, reasons } = args;
	const vramGb = probe.gpu?.totalVramGb ?? 0;
	const totalRamGb = probe.totalRamGb;
	const freeRamGb = probe.freeRamGb;
	const cpuCores = probe.cpuCores;

	if (!avx2) {
		reasons.push("No AVX2 baseline (or < 4 CPU cores)");
		return "POOR";
	}

	const max = DEVICE_TIER_THRESHOLDS.MAX;
	const good = DEVICE_TIER_THRESHOLDS.GOOD;
	const okay = DEVICE_TIER_THRESHOLDS.OKAY;

	// MAX gate.
	const meetsMaxEffective = effective >= max.effectiveModelMemoryGb;
	const meetsMaxFree = freeRamGb >= max.freeRamGbAtSession;
	const meetsMaxGpu = vramGb >= max.dGpuMinVramGb;
	const meetsMaxAppleSilicon =
		probe.appleSilicon && totalRamGb >= max.appleSiliconMinUnifiedGb;

	if (
		!mobile &&
		meetsMaxEffective &&
		meetsMaxFree &&
		(meetsMaxGpu || meetsMaxAppleSilicon)
	) {
		reasons.push(
			`${effective.toFixed(1)} GB effective model RAM, ${freeRamGb.toFixed(1)} GB free, ${
				meetsMaxAppleSilicon
					? `Apple Silicon ${totalRamGb.toFixed(0)} GB unified`
					: `${vramGb} GB VRAM`
			}`,
		);
		return "MAX";
	}

	// GOOD gate.
	const meetsGoodEffective = effective >= good.effectiveModelMemoryGb;
	const meetsGoodFree = freeRamGb >= good.freeRamGbAtSession;
	const meetsGoodGpu = vramGb >= good.dGpuMinVramGb;
	const meetsGoodAppleSilicon =
		probe.appleSilicon && totalRamGb >= good.appleSiliconMinUnifiedGb;
	const meetsGoodCpu =
		!probe.gpu &&
		!probe.appleSilicon &&
		totalRamGb >= good.x86CpuOnlyMinTotalGb &&
		cpuCores >= 4;

	if (
		!mobile &&
		meetsGoodEffective &&
		meetsGoodFree &&
		(meetsGoodGpu || meetsGoodAppleSilicon || meetsGoodCpu)
	) {
		reasons.push(
			`${effective.toFixed(1)} GB effective model RAM, ${freeRamGb.toFixed(1)} GB free, ${
				meetsGoodAppleSilicon
					? `Apple Silicon ${totalRamGb.toFixed(0)} GB unified`
					: meetsGoodGpu
						? `${vramGb} GB VRAM`
						: `${totalRamGb.toFixed(0)} GB RAM, ${cpuCores} cores`
			}`,
		);
		return "GOOD";
	}

	// OKAY gate.
	const meetsOkayEffective = effective >= okay.effectiveModelMemoryGb;
	const meetsOkayFree = freeRamGb >= okay.freeRamGbAtSession;
	const meetsOkayTotal =
		totalRamGb >= (mobile ? okay.mobileMinTotalRamGb : okay.minTotalRamGb);

	if (meetsOkayEffective && meetsOkayFree && meetsOkayTotal) {
		reasons.push(
			`${effective.toFixed(1)} GB effective model RAM, ${freeRamGb.toFixed(1)} GB free, ${totalRamGb.toFixed(1)} GB total`,
		);
		return "OKAY";
	}

	reasons.push(
		`Below OKAY thresholds — effective ${effective.toFixed(1)} GB / free ${freeRamGb.toFixed(1)} GB / total ${totalRamGb.toFixed(1)} GB`,
	);
	return "POOR";
}

function tierRank(tier: DeviceTier): number {
	return DEVICE_TIER_ORDER.indexOf(tier);
}

function previousTier(tier: DeviceTier): DeviceTier {
	const idx = tierRank(tier);
	if (idx <= 0) return "POOR";
	return DEVICE_TIER_ORDER[idx - 1];
}

function topRecommendationFor(tier: DeviceTier, mobile: boolean): string {
	if (mobile) {
		switch (tier) {
			case "MAX":
			case "GOOD":
				return "Run local voice; cloud LM optional for the largest tiers.";
			case "OKAY":
				return "Use cloud voice (cloud TTS + ASR). Local turn detection + VAD + wake-word stay on-device.";
			case "POOR":
				return "Use cloud mode. This device is below the local-voice budget.";
		}
	}
	switch (tier) {
		case "MAX":
			return "Run everything locally with all models held in memory in parallel.";
		case "GOOD":
			return "Run everything locally; models stay loaded but run one at a time.";
		case "OKAY":
			return "Local voice works but models swap in/out between turns. Consider cloud voice for faster turnaround.";
		case "POOR":
			return "Use cloud mode. Local responses will be very slow on this device.";
	}
}

/**
 * Warning-copy strings for each tier. The exact prose comes from R9 §7;
 * I10 surfaces these via the `voice-tier.json` i18n bundle. Keep this in
 * sync with `packages/ui/src/i18n/voice-tier.json`.
 */
export const TIER_WARNING_COPY: Readonly<
	Record<
		DeviceTier,
		{
			header: string;
			body: string;
		}
	>
> = {
	MAX: {
		header: "Your device is in the MAX tier for on-device Eliza.",
		body: "Your device can run every local model in parallel: text, voice, ASR, turn detection, speaker recognition, and emotion — all resident at the same time. Expected first-audio latency under 250 ms.",
	},
	GOOD: {
		header: "Your device is in the GOOD tier for on-device Eliza.",
		body: "Your device can keep every local model loaded but will run them one at a time. Text responses, voice synthesis, and ASR are all local; only one heavy model is active per turn. Expected first-audio latency 300–600 ms.",
	},
	OKAY: {
		header: "Your device is in the OKAY tier for on-device Eliza.",
		body: "Your device will load and unload local models as they're needed. Caching does not survive a model swap, so the first response after voice + image-gen at once will be slow. Expected first-audio latency 600–1500 ms. Consider cloud voice for faster turnaround.",
	},
	POOR: {
		header: "This device is in the POOR tier for on-device Eliza.",
		body: "This device is below the local-voice memory budget. Local responses will be very slow and may fail to load. We recommend Cloud mode — your turn-detection and VAD still run locally for privacy.",
	},
};

/** Convenience: total RAM in MB. */
export function totalRamMb(probe: HardwareProbe): number {
	return Math.round(probe.totalRamGb * MB_PER_GB);
}
