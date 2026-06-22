/**
 * Live device signals for the capability-driven `auto` routing policy.
 *
 * `classifyDeviceTier()` is a *static* assessment — it scores the hardware once
 * and caches the result. But a device that classifies MAX/GOOD at session start
 * can still become a poor place to run local inference *right now*: a sustained
 * workload pushes the SoC into thermal throttling, or decode throughput collapses
 * under memory pressure. Those are live, time-varying signals the static tier
 * cannot see.
 *
 * This module exposes the two live signals the `auto` branch demotes on:
 *
 *   - **thermal state** — read from the device bridge's most recent device
 *     capabilities (`nominal | fair | serious | critical | unknown`). `serious`
 *     or `critical` means the OS is actively throttling clocks; forcing local
 *     inference there makes turns slower than cloud and worsens the throttle.
 *   - **decode throughput** — the recent p50 decode tokens/sec from
 *     `inferenceTelemetry`. When it falls below a usable budget the on-device
 *     path is no longer competitive and `auto` routes to cloud.
 *
 * Both signals are *optional*: a quantity the host could not measure is reported
 * as `null` (never a fabricated `0`), and a `null` signal never demotes — the
 * static tier decision stands. The default source reads the real subsystems; a
 * test or alternate host can inject its own via `setLiveDeviceSignalsSource`.
 */

import { deviceBridge } from "./device-bridge";
import { inferenceTelemetry } from "./inference-telemetry";

/** Thermal pressure reported by the OS. Mirrors the device-bridge wire enum. */
export type ThermalState =
	| "nominal"
	| "fair"
	| "serious"
	| "critical"
	| "unknown";

/**
 * The telemetry metric name carrying recent on-device decode throughput
 * (tokens/sec). The backend records this after a generation completes; until
 * then `summary()` returns a `count: 0` row and the signal is `null`.
 */
export const DECODE_TPS_METRIC = "inference.decode_tps";

/**
 * Minimum decode throughput (tokens/sec) below which the local path is no longer
 * worth keeping under `auto`. Roughly the floor where on-device generation feels
 * slower than a cloud round-trip on a constrained mobile SoC.
 */
export const MIN_DECODE_TPS_BUDGET = 6;

/** A point-in-time snapshot of the live device signals. */
export interface LiveDeviceSignals {
	/** Current OS thermal pressure, or `null` when no device reported it. */
	thermalState: ThermalState | null;
	/** Recent p50 decode throughput in tokens/sec, or `null` when unmeasured. */
	decodeTokensPerSecond: number | null;
}

/** A source of live device signals — swappable for tests and alternate hosts. */
export type LiveDeviceSignalsSource = () => LiveDeviceSignals;

const VALID_THERMAL_STATES: ReadonlySet<string> = new Set([
	"nominal",
	"fair",
	"serious",
	"critical",
	"unknown",
]);

function normalizeThermalState(value: unknown): ThermalState | null {
	return typeof value === "string" && VALID_THERMAL_STATES.has(value)
		? (value as ThermalState)
		: null;
}

/**
 * The default source: thermal from the device bridge's primary device, decode
 * tok/s from the telemetry ring. Pure reads — never throws into the router.
 */
const defaultSource: LiveDeviceSignalsSource = () => {
	const thermalState = normalizeThermalState(
		deviceBridge.status().capabilities?.thermalState,
	);
	const decodeTokensPerSecond =
		inferenceTelemetry.summary(DECODE_TPS_METRIC).p50;
	return { thermalState, decodeTokensPerSecond };
};

let activeSource: LiveDeviceSignalsSource = defaultSource;

/** Read the current live device signals. */
export function readLiveDeviceSignals(): LiveDeviceSignals {
	return activeSource();
}

/**
 * Override the live-signals source. Pass `null` to restore the default
 * (device-bridge + telemetry) source. Intended for tests and alternate hosts.
 */
export function setLiveDeviceSignalsSource(
	source: LiveDeviceSignalsSource | null,
): void {
	activeSource = source ?? defaultSource;
}

/**
 * Whether the live signals say the device should be demoted off local for now,
 * even though the static tier favours local. True when the OS is throttling
 * (`serious`/`critical`) or measured decode throughput sits below the budget.
 * A `null` signal never demotes.
 */
export function liveSignalsDemoteLocal(signals: LiveDeviceSignals): boolean {
	if (
		signals.thermalState === "serious" ||
		signals.thermalState === "critical"
	) {
		return true;
	}
	if (
		signals.decodeTokensPerSecond !== null &&
		signals.decodeTokensPerSecond < MIN_DECODE_TPS_BUDGET
	) {
		return true;
	}
	return false;
}
