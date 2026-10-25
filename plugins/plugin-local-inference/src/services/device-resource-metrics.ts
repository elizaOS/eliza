/**
 * DeviceResourceMetrics — on-device resource profiling accumulator.
 *
 * Sibling to `VoiceRunMetrics` (`latency-trace.ts`), generalised for the Mobile
 * Resource Workbench (issue #8800). Where `VoiceRunMetrics` accumulates the
 * non-latency signals of a *host-side* voice run (server RSS, MTP accept-rate),
 * this accumulates the signals of an *on-device* agent run:
 *
 *   - per-generation **prefill / decode / combined tokens-per-second** + TTFT
 *     (fed from the device-bridge `computeGenerationThroughput` differencing),
 *   - **peak + steady resident memory (RSS)** with an RSS-leak flag,
 *   - **battery drain** (% and, where the OS exposes a charge counter, µAh),
 *   - a **thermal-state timeline** + transition count,
 *   - **low-power-mode transitions**.
 *
 * Every field is optional on input and every output is `null` when nothing
 * could be measured — a quantity the device could not report is recorded as
 * missing, never as a fabricated `0` (AGENTS.md §3 / §7). The workbench writes
 * `summary()` to `results/<workload>/latest.json`.
 */

import { BoundedHistogram, type HistogramSummary } from "./latency-trace";

export type DeviceThermalState =
	| "nominal"
	| "fair"
	| "serious"
	| "critical"
	| "unknown";

/** Severity rank for thermal states. `unknown` is unranked (excluded). */
const THERMAL_RANK: Record<Exclude<DeviceThermalState, "unknown">, number> = {
	nominal: 0,
	fair: 1,
	serious: 2,
	critical: 3,
};

/** A single generation's differenced throughput (see `throughput.ts`). */
export interface GenerationObservation {
	prefillTokensPerSecond?: number | null;
	decodeTokensPerSecond?: number | null;
	combinedTokensPerSecond?: number | null;
	ttftMs?: number | null;
}

/**
 * A sampled device-resource snapshot, taken on an interval across a workload.
 * Sourced from the native `getResourceSnapshot` bridge (iOS/Android) and/or
 * host-side OS probes (`adb dumpsys`, `/proc`).
 */
export interface ResourceSample {
	/** Timestamp in ms (epoch or run-relative); orders the timeline + drain rate. */
	atMs: number;
	/** Resident set size in MB (peak / steady / leak tracking). */
	residentMemoryMb?: number | null;
	/** Available device RAM in MB at sample time. */
	availableRamMb?: number | null;
	/** Battery level 0..100. */
	batteryLevelPct?: number | null;
	/** Cumulative charge counter in µAh (Android `BATTERY_PROPERTY_CHARGE_COUNTER`). */
	batteryChargeMicroAmpHours?: number | null;
	/** Whether the device was charging at sample time. */
	isCharging?: boolean | null;
	thermalState?: DeviceThermalState | null;
	lowPowerMode?: boolean | null;
	/** Cumulative process CPU time in ms, when the platform exposes it. */
	cpuTimeMs?: number | null;
}

export interface RssSummary {
	firstMb: number | null;
	lastMb: number | null;
	peakMb: number | null;
	/** Median RSS over the back half of the run (warm/steady state). */
	steadyMb: number | null;
	samples: number;
	/** lastMb − firstMb, or null. */
	growthMb: number | null;
	/** True when RSS is monotone non-decreasing across ≥4 samples and grew past the threshold. */
	leakSuspected: boolean;
}

export interface BatterySummary {
	firstPct: number | null;
	lastPct: number | null;
	/** firstPct − lastPct (positive = battery consumed), or null. */
	drainPct: number | null;
	samples: number;
	/** True if any sample reported charging (drain numbers are then unreliable). */
	chargingObserved: boolean;
	/** firstCharge − lastCharge in µAh (positive = consumed), when the counter is present. */
	energyMicroAmpHoursDelta: number | null;
	/** Wall-clock span across battery samples in ms, or null. */
	durationMs: number | null;
}

export interface ThermalTransition {
	atMs: number;
	state: DeviceThermalState;
}

export interface ThermalSummary {
	samples: number;
	initialState: DeviceThermalState | null;
	/** Worst (highest-severity) known state observed. */
	maxState: DeviceThermalState | null;
	/** State-change timeline (first known state + every change after). */
	transitions: ThermalTransition[];
	transitionCount: number;
	/** Fraction of known-state samples at serious|critical, or null when no known state. */
	fractionThrottled: number | null;
}

export interface LowPowerSummary {
	samples: number;
	everEnabled: boolean;
	transitionCount: number;
}

export interface DeviceResourceSummary {
	generations: number;
	resourceSamples: number;
	prefillTokensPerSecond: HistogramSummary;
	decodeTokensPerSecond: HistogramSummary;
	combinedTokensPerSecond: HistogramSummary;
	ttftMs: HistogramSummary;
	rss: RssSummary;
	battery: BatterySummary;
	thermal: ThermalSummary;
	lowPowerMode: LowPowerSummary;
}

const HISTOGRAM_CAPACITY = 1024;
const DEFAULT_LEAK_GROWTH_MB = 256;
/** Cap the thermal timeline so a long run cannot grow it without bound. */
const MAX_THERMAL_TRANSITIONS = 256;

function isFiniteNumber(v: number | null | undefined): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2
		? (s[mid] as number)
		: ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export class DeviceResourceMetrics {
	private generations = 0;
	private readonly prefillHist = new BoundedHistogram(HISTOGRAM_CAPACITY);
	private readonly decodeHist = new BoundedHistogram(HISTOGRAM_CAPACITY);
	private readonly combinedHist = new BoundedHistogram(HISTOGRAM_CAPACITY);
	private readonly ttftHist = new BoundedHistogram(HISTOGRAM_CAPACITY);

	private readonly rssSamples: number[] = [];

	private resourceSamples = 0;
	private firstBattery: { pct: number; atMs: number } | null = null;
	private lastBattery: { pct: number; atMs: number } | null = null;
	private firstChargeUah: number | null = null;
	private lastChargeUah: number | null = null;
	private batterySampleCount = 0;
	private chargingObserved = false;

	private thermalSampleCount = 0;
	private thermalInitial: DeviceThermalState | null = null;
	private thermalLast: DeviceThermalState | null = null;
	private thermalMaxRank = -1;
	private thermalMaxState: DeviceThermalState | null = null;
	private thermalThrottledCount = 0;
	private thermalKnownCount = 0;
	private readonly thermalTransitions: ThermalTransition[] = [];

	private lowPowerSampleCount = 0;
	private lowPowerEver = false;
	private lowPowerLast: boolean | null = null;
	private lowPowerTransitions = 0;

	constructor(private readonly opts: { leakGrowthMbThreshold?: number } = {}) {}

	/** Record one generation's differenced throughput. */
	recordGeneration(obs: GenerationObservation): void {
		this.generations += 1;
		if (isFiniteNumber(obs.prefillTokensPerSecond))
			this.prefillHist.add(obs.prefillTokensPerSecond);
		if (isFiniteNumber(obs.decodeTokensPerSecond))
			this.decodeHist.add(obs.decodeTokensPerSecond);
		if (isFiniteNumber(obs.combinedTokensPerSecond))
			this.combinedHist.add(obs.combinedTokensPerSecond);
		if (isFiniteNumber(obs.ttftMs)) this.ttftHist.add(obs.ttftMs);
	}

	/** Record one sampled device-resource snapshot. */
	recordResourceSample(sample: ResourceSample): void {
		this.resourceSamples += 1;

		if (isFiniteNumber(sample.residentMemoryMb))
			this.rssSamples.push(sample.residentMemoryMb);

		if (isFiniteNumber(sample.batteryLevelPct)) {
			const entry = { pct: sample.batteryLevelPct, atMs: sample.atMs };
			if (this.firstBattery === null) this.firstBattery = entry;
			this.lastBattery = entry;
			this.batterySampleCount += 1;
		}
		if (isFiniteNumber(sample.batteryChargeMicroAmpHours)) {
			if (this.firstChargeUah === null)
				this.firstChargeUah = sample.batteryChargeMicroAmpHours;
			this.lastChargeUah = sample.batteryChargeMicroAmpHours;
		}
		if (sample.isCharging === true) this.chargingObserved = true;

		if (sample.thermalState != null) {
			this.thermalSampleCount += 1;
			if (this.thermalInitial === null)
				this.thermalInitial = sample.thermalState;
			const known = sample.thermalState !== "unknown";
			if (known) {
				this.thermalKnownCount += 1;
				const rank =
					THERMAL_RANK[
						sample.thermalState as Exclude<DeviceThermalState, "unknown">
					];
				if (rank > this.thermalMaxRank) {
					this.thermalMaxRank = rank;
					this.thermalMaxState = sample.thermalState;
				}
				if (rank >= THERMAL_RANK.serious) this.thermalThrottledCount += 1;
			}
			if (
				sample.thermalState !== this.thermalLast &&
				this.thermalTransitions.length < MAX_THERMAL_TRANSITIONS
			) {
				this.thermalTransitions.push({
					atMs: sample.atMs,
					state: sample.thermalState,
				});
			}
			this.thermalLast = sample.thermalState;
		}

		if (typeof sample.lowPowerMode === "boolean") {
			this.lowPowerSampleCount += 1;
			if (sample.lowPowerMode) this.lowPowerEver = true;
			if (
				this.lowPowerLast !== null &&
				this.lowPowerLast !== sample.lowPowerMode
			)
				this.lowPowerTransitions += 1;
			this.lowPowerLast = sample.lowPowerMode;
		}
	}

	private rssSummary(): RssSummary {
		const n = this.rssSamples.length;
		const firstMb = n > 0 ? (this.rssSamples[0] as number) : null;
		const lastMb = n > 0 ? (this.rssSamples[n - 1] as number) : null;
		const peakMb = n > 0 ? Math.max(...this.rssSamples) : null;
		// Steady state = median of the back half (excludes cold-load ramp).
		const backHalf =
			n >= 2 ? this.rssSamples.slice(Math.floor(n / 2)) : this.rssSamples;
		const steadyMb = median(backHalf);
		const growthMb =
			firstMb !== null && lastMb !== null ? lastMb - firstMb : null;
		const threshold = this.opts.leakGrowthMbThreshold ?? DEFAULT_LEAK_GROWTH_MB;
		let monotone = n >= 4;
		for (let i = 1; i < n; i++) {
			if ((this.rssSamples[i] as number) < (this.rssSamples[i - 1] as number)) {
				monotone = false;
				break;
			}
		}
		const leakSuspected = monotone && growthMb !== null && growthMb > threshold;
		return {
			firstMb,
			lastMb,
			peakMb,
			steadyMb,
			samples: n,
			growthMb,
			leakSuspected,
		};
	}

	private batterySummary(): BatterySummary {
		const firstPct = this.firstBattery?.pct ?? null;
		const lastPct = this.lastBattery?.pct ?? null;
		const drainPct =
			firstPct !== null && lastPct !== null ? firstPct - lastPct : null;
		const energyMicroAmpHoursDelta =
			this.firstChargeUah !== null && this.lastChargeUah !== null
				? this.firstChargeUah - this.lastChargeUah
				: null;
		const durationMs =
			this.firstBattery !== null && this.lastBattery !== null
				? this.lastBattery.atMs - this.firstBattery.atMs
				: null;
		return {
			firstPct,
			lastPct,
			drainPct,
			samples: this.batterySampleCount,
			chargingObserved: this.chargingObserved,
			energyMicroAmpHoursDelta,
			durationMs,
		};
	}

	private thermalSummary(): ThermalSummary {
		const fractionThrottled =
			this.thermalKnownCount > 0
				? this.thermalThrottledCount / this.thermalKnownCount
				: null;
		return {
			samples: this.thermalSampleCount,
			initialState: this.thermalInitial,
			maxState: this.thermalMaxState,
			transitions: [...this.thermalTransitions],
			transitionCount: Math.max(0, this.thermalTransitions.length - 1),
			fractionThrottled,
		};
	}

	summary(): DeviceResourceSummary {
		return {
			generations: this.generations,
			resourceSamples: this.resourceSamples,
			prefillTokensPerSecond: this.prefillHist.summary(),
			decodeTokensPerSecond: this.decodeHist.summary(),
			combinedTokensPerSecond: this.combinedHist.summary(),
			ttftMs: this.ttftHist.summary(),
			rss: this.rssSummary(),
			battery: this.batterySummary(),
			thermal: this.thermalSummary(),
			lowPowerMode: {
				samples: this.lowPowerSampleCount,
				everEnabled: this.lowPowerEver,
				transitionCount: this.lowPowerTransitions,
			},
		};
	}
}
