/**
 * Optimistic-generation policy — Wave 3 W3-9.
 *
 * Decides whether the LM should fire optimistically the moment the turn
 * detector crosses the EOT threshold (before the audio buffer is fully
 * drained), or wait for the full hangover. Per the user spec:
 *
 *   > "We want to optimize to start running and checking basically the
 *    second there is no audio / voice detected, and then we start
 *    optimistically processing, and if the user starts talking again we
 *    kill and add to the conversation and start reprocessing."
 *
 * Default heuristic:
 *   - Plugged-in (or power state unknown): optimistic = true.
 *   - On battery: optimistic = false (the extra forward pass burns
 *     joules every false-positive EOT).
 *
 * Callers (notably `VoiceStateMachine`) read `shouldStartOptimisticLm()`
 * each time they consider firing the speculative drafter. The policy can be
 * mutated at runtime via `setOptimisticOverride()` so a Settings UI toggle
 * or a per-session env var can pin the value without restarting the engine.
 */

/** Power-source signal. `unknown` is treated as "plugged in" for the
 *  default policy (a desktop without battery telemetry). */
export type PowerSourceState = "plugged-in" | "battery" | "unknown";

/**
 * Resolve the current power-source state.
 *
 * Production callers (engine bridge) prime the optimistic policy with this
 * once at session start. There is no canonical power-source accessor in
 * `device-tier.ts` (the hardware probe records RAM / GPU / cores but no
 * battery telemetry), so this resolver consults two cheap signals:
 *
 *   1. `ELIZA_VOICE_POWER_SOURCE` env var (`"plugged-in" | "battery" |
 *      "unknown"`). Wins outright when set — operators / Settings can pin
 *      the policy without restarting the engine.
 *   2. Linux `/sys/class/power_supply` AC online status when available
 *      synchronously. Returns `"plugged-in"` when any AC adapter reports
 *      `online`, `"battery"` when only batteries are present and none
 *      report online, `"unknown"` otherwise.
 *
 * macOS / Windows / mobile go through `"unknown"` here — the desktop probe
 * surfaces those via the Electrobun side and Settings overrides it through
 * (1). The default heuristic (`unknown → enabled`) treats those as
 * plugged-in for the optimistic gate, which is the right default for
 * desktop / dev (battery-aware mobile builds set the override explicitly).
 */
export function resolvePowerSourceState(): PowerSourceState {
	const fromEnv = process.env.ELIZA_VOICE_POWER_SOURCE?.trim().toLowerCase();
	if (
		fromEnv === "plugged-in" ||
		fromEnv === "battery" ||
		fromEnv === "unknown"
	) {
		return fromEnv;
	}
	if (process.platform === "linux") {
		try {
			// Lazy require so this module stays free of node-fs imports for
			// non-linux platforms / browser bundlers.
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const fs = require("node:fs") as typeof import("node:fs");
			const base = "/sys/class/power_supply";
			if (!fs.existsSync(base)) return "unknown";
			const entries = fs.readdirSync(base);
			let sawBattery = false;
			for (const entry of entries) {
				const typePath = `${base}/${entry}/type`;
				if (!fs.existsSync(typePath)) continue;
				const type = fs.readFileSync(typePath, "utf8").trim();
				if (type === "Mains") {
					const onlinePath = `${base}/${entry}/online`;
					if (
						fs.existsSync(onlinePath) &&
						fs.readFileSync(onlinePath, "utf8").trim() === "1"
					) {
						return "plugged-in";
					}
				} else if (type === "Battery") {
					sawBattery = true;
				}
			}
			return sawBattery ? "battery" : "unknown";
		} catch {
			return "unknown";
		}
	}
	return "unknown";
}

export interface OptimisticPolicyOptions {
	/**
	 * Default value when no override is set. Resolved from the device tier
	 * at construction time (per the user spec: true on plugged-in,
	 * false on battery). Defaults to `true` when no power signal is given.
	 */
	defaultEnabled?: boolean;
	/**
	 * The threshold the turn detector's EOT probability must clear before
	 * the optimistic LM start fires. Mirrors `EOT_TENTATIVE_THRESHOLD`
	 * (the existing default) but is configurable per-policy so tier-aware
	 * deployments can tighten it on slower devices.
	 */
	eotThreshold?: number;
}

export interface ResolveOptimisticPolicyArgs {
	powerSource?: PowerSourceState;
	/**
	 * Explicit override. When set, wins over both the default and the
	 * power-source heuristic. Sourced from `voice.optimisticGenerationOnEot`
	 * in user settings (Wave 3C).
	 */
	override?: boolean;
}

export const DEFAULT_OPTIMISTIC_EOT_THRESHOLD = 0.6;

/**
 * Pure resolver. Takes the power source + an optional override and returns
 * whether optimistic LM start should fire.
 */
export function resolveOptimisticPolicyEnabled(
	args: ResolveOptimisticPolicyArgs,
): boolean {
	if (typeof args.override === "boolean") return args.override;
	if (args.powerSource === "battery") return false;
	// plugged-in OR unknown OR undefined → enabled (safer default for
	// desktop / dev where power telemetry isn't surfaced).
	return true;
}

/**
 * Mutable runtime policy. The voice state machine asks
 * `policy.shouldStartOptimisticLm(eotProb)` before firing the drafter.
 *
 * Reasoning for a class rather than a free function: at runtime we need
 * the override + the power source to be hot-swappable from Settings or a
 * device-event listener (battery state change) without re-plumbing the
 * machine.
 */
export class OptimisticGenerationPolicy {
	private overrideValue: boolean | undefined;
	private powerSource: PowerSourceState;
	private readonly defaultEnabled: boolean;
	private readonly eotThreshold: number;

	constructor(opts: OptimisticPolicyOptions = {}) {
		this.defaultEnabled = opts.defaultEnabled ?? true;
		this.eotThreshold = opts.eotThreshold ?? DEFAULT_OPTIMISTIC_EOT_THRESHOLD;
		this.powerSource = "unknown";
	}

	/** Update the power source (called by the device-tier observer). */
	setPowerSource(state: PowerSourceState): void {
		this.powerSource = state;
	}

	/** Set / clear the user override. */
	setOverride(value: boolean | undefined): void {
		this.overrideValue = value;
	}

	/** Resolve "should we be optimistic right now?". */
	enabled(): boolean {
		// Explicit user override wins outright.
		if (typeof this.overrideValue === "boolean") return this.overrideValue;
		// No override: apply the battery heuristic on top of `defaultEnabled`.
		// `defaultEnabled=false` pins the policy off regardless of power source;
		// `defaultEnabled=true` enables it on plugged-in / unknown and disables
		// it on battery.
		if (!this.defaultEnabled) return false;
		return resolveOptimisticPolicyEnabled({ powerSource: this.powerSource });
	}

	/**
	 * Combined gate: the policy must be enabled AND the EOT probability
	 * must clear the policy's threshold. This is the canonical check the
	 * voice state machine calls before firing the drafter on a partial
	 * transcript.
	 */
	shouldStartOptimisticLm(eotProb: number): boolean {
		if (!this.enabled()) return false;
		return eotProb >= this.eotThreshold;
	}

	get threshold(): number {
		return this.eotThreshold;
	}
}
