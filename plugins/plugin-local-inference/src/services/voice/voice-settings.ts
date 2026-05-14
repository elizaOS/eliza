/**
 * Voice settings — the user-facing knobs the runtime + UI consume to
 * decide local vs cloud, model quality, RAM cap, and quant downgrade.
 *
 * R9 §5 spells out the five knobs:
 *
 *   1. `voice.forceLocal` / `voice.forceCloud` / `voice.autoSwap` — backend
 *      mode (auto by default).
 *   2. `voice.modelQualityPreset` — `"max" | "balanced" | "minimal"`.
 *   3. `voice.maxRamMB` — hard cap on the allocator's total budget.
 *   4. `voice.allowQuantDowngrade` — auto-pick smaller quants if RAM tight.
 *
 * This module is the env-var resolver + the canonical default table. The
 * dashboard's Settings panel writes the same fields to `messages.voice.*`
 * config; I10 wires the persistent store. For now (I9 scope), the resolver
 * reads env + an optional `Partial<VoiceSettings>` overlay so tests can
 * lock in deterministic behaviour.
 *
 * There is no central `settings.ts` to extend in `plugins/plugin-local-
 * inference/src/services/` today (R9 §1 path inventory confirms it).
 * Keeping this file in `voice/` makes its surface area obvious.
 */

import { type DeviceTier } from "../device-tier";

export type VoiceBackendMode = "auto" | "force-local" | "force-cloud";
export type VoiceModelQualityPreset = "max" | "balanced" | "minimal";

export interface VoiceSettings {
	/** Backend selection mode. `auto` consults the device tier. */
	backendMode: VoiceBackendMode;
	/** When `backendMode === "auto"`, allow the runtime to swap between
	 *  cloud and local in mid-session to keep latency bounded. */
	autoSwap: boolean;
	/** Quality vs RAM tradeoff. Maps to a quant ladder for the LM + voice
	 *  stack — see `qualityPresetQuantizationRanking()`. */
	modelQualityPreset: VoiceModelQualityPreset;
	/** Hard cap on the allocator's total budget, in MB. 0 / null = use the
	 *  tier's natural total. */
	maxRamMb: number | null;
	/** When true (default), an OOM-pending reservation may pick a smaller
	 *  quant variant instead of refusing. When false, `reserve()` throws. */
	allowQuantDowngrade: boolean;
	/** Continuous local recording on mobile when on battery. Off by default. */
	continuousLocalRecordingOnBattery: boolean;
}

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
	backendMode: "auto",
	autoSwap: true,
	modelQualityPreset: "balanced",
	maxRamMb: null,
	allowQuantDowngrade: true,
	continuousLocalRecordingOnBattery: false,
};

function parseBackendMode(value: string | undefined): VoiceBackendMode | null {
	if (!value) return null;
	const v = value.trim().toLowerCase();
	if (v === "auto") return "auto";
	if (v === "force-local" || v === "local") return "force-local";
	if (v === "force-cloud" || v === "cloud") return "force-cloud";
	return null;
}

function parseQualityPreset(
	value: string | undefined,
): VoiceModelQualityPreset | null {
	if (!value) return null;
	const v = value.trim().toLowerCase();
	if (v === "max") return "max";
	if (v === "balanced") return "balanced";
	if (v === "minimal" || v === "efficient" || v === "min") return "minimal";
	return null;
}

function parseBool(value: string | undefined): boolean | null {
	if (!value) return null;
	const v = value.trim().toLowerCase();
	if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
	if (v === "0" || v === "false" || v === "no" || v === "off") return false;
	return null;
}

function parseNumberMb(value: string | undefined): number | null {
	if (!value) return null;
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n) || n <= 0) return null;
	return n;
}

/**
 * Resolve voice settings from environment + an optional overlay.
 * Env wins over defaults; overlay wins over env (so tests / UI can lock
 * specific fields). All fields are required in the returned settings.
 *
 * Env knobs (canonical ELIZA_* prefix; MILADY_* aliases honored upstream):
 *
 *   - `ELIZA_VOICE_BACKEND_MODE`        → backendMode
 *   - `ELIZA_VOICE_AUTO_SWAP`           → autoSwap
 *   - `ELIZA_VOICE_QUALITY_PRESET`      → modelQualityPreset
 *   - `ELIZA_VOICE_MAX_RAM_MB`          → maxRamMb
 *   - `ELIZA_VOICE_ALLOW_QUANT_DOWNGRADE` → allowQuantDowngrade
 *   - `ELIZA_VOICE_CONTINUOUS_ON_BATTERY` → continuousLocalRecordingOnBattery
 */
export function resolveVoiceSettings(
	overlay: Partial<VoiceSettings> = {},
	env: NodeJS.ProcessEnv = process.env,
): VoiceSettings {
	const fromEnv: Partial<VoiceSettings> = {};
	const backendMode = parseBackendMode(env.ELIZA_VOICE_BACKEND_MODE);
	if (backendMode) fromEnv.backendMode = backendMode;
	const autoSwap = parseBool(env.ELIZA_VOICE_AUTO_SWAP);
	if (autoSwap !== null) fromEnv.autoSwap = autoSwap;
	const preset = parseQualityPreset(env.ELIZA_VOICE_QUALITY_PRESET);
	if (preset) fromEnv.modelQualityPreset = preset;
	const maxRamMb = parseNumberMb(env.ELIZA_VOICE_MAX_RAM_MB);
	if (maxRamMb !== null) fromEnv.maxRamMb = maxRamMb;
	const allowQuantDowngrade = parseBool(env.ELIZA_VOICE_ALLOW_QUANT_DOWNGRADE);
	if (allowQuantDowngrade !== null)
		fromEnv.allowQuantDowngrade = allowQuantDowngrade;
	const continuousBattery = parseBool(env.ELIZA_VOICE_CONTINUOUS_ON_BATTERY);
	if (continuousBattery !== null)
		fromEnv.continuousLocalRecordingOnBattery = continuousBattery;

	return { ...DEFAULT_VOICE_SETTINGS, ...fromEnv, ...overlay };
}

/**
 * Default backend mode given the user's settings + the device tier. R9 §5:
 *
 *   - `force-local` overrides the mobile-cloud-default;
 *   - `force-cloud` overrides the desktop-local-default;
 *   - `auto` consults the tier (MAX/GOOD → local; OKAY/POOR → cloud).
 *
 * Returns the resolved mode the runtime should *act on*, taking the tier
 * into account.
 */
export function effectiveBackendMode(
	settings: VoiceSettings,
	tier: DeviceTier,
): "local" | "cloud" {
	if (settings.backendMode === "force-local") return "local";
	if (settings.backendMode === "force-cloud") return "cloud";
	// auto
	if (tier === "MAX" || tier === "GOOD") return "local";
	return "cloud";
}

/**
 * Ordered quant ladder per quality preset. Most-preferred first. Loaders
 * pick the most-preferred variant that fits the budget; `allowQuantDowngrade`
 * controls whether they slide down the ladder when the top choice doesn't
 * fit.
 *
 * Names match the catalog ids in `recommendation.ts:textQuantizationMatrix`
 * + the voice stack's documented variants.
 */
export function qualityPresetQuantizationRanking(
	preset: VoiceModelQualityPreset,
): ReadonlyArray<string> {
	switch (preset) {
		case "max":
			return ["Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q3_K_M"];
		case "balanced":
			return ["Q4_K_M", "Q5_K_M", "Q6_K", "Q3_K_M", "Q8_0"];
		case "minimal":
			return ["Q3_K_M", "Q4_K_M", "Q5_K_M", "Q6_K"];
	}
}

export { DEFAULT_VOICE_SETTINGS };
