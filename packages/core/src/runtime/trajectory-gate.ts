/**
 * Single on/off resolver for trajectory persistence, consulted by both the
 * file recorder (`isTrajectoryRecordingEnabled`, trajectory-recorder.ts) and
 * the DB logger (`shouldEnableTrajectoryLoggingByDefault`,
 * agent/trajectory-internals.ts) so the two recorders can no longer disagree —
 * the prior split had prod dark for the DB viewer while files kept writing, and
 * test-off for the DB while files stayed on (#13775).
 *
 * The policy encodes SOC2 O-5 (production is opt-in, never on by default) and a
 * test default of off (keeps the test runner free of background trajectory
 * writes). `ELIZA_TRAJECTORY_LOGGING` is the canonical operator knob;
 * `ELIZA_TRAJECTORY_RECORDING` is the legacy alias the file recorder used and
 * is honored for back-compat. When neither explicit knob is set the NODE_ENV
 * defaults apply.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Coerce a raw env value to a boolean. Returns undefined when the var is unset
 * (so the caller can fall through to the next precedence tier); a set-but-not-
 * truthy value coerces to false (an explicit opt-out).
 */
function coerceFlag(raw: string | undefined): boolean | undefined {
	if (raw === undefined) return undefined;
	return TRUTHY.has(raw.trim().toLowerCase());
}

export interface TrajectoryGateDecision {
	enabled: boolean;
	/** Which precedence tier decided, for diagnostics/logging. */
	reason: string;
}

/**
 * Resolve whether trajectory persistence is enabled. Precedence (first match
 * wins):
 *
 *   1. `ELIZA_DISABLE_TRAJECTORY_LOGGING=1` — hard operator opt-out.
 *   2. `ELIZA_TRAJECTORY_LOGGING` explicit — canonical operator knob.
 *   3. `ELIZA_TRAJECTORY_RECORDING` explicit — legacy alias (file recorder).
 *   4. `NODE_ENV=test` — off (no background writes during tests).
 *   5. `NODE_ENV=production` — off (SOC2 O-5: operators must opt in via tier 2).
 *   6. otherwise (dev / unset NODE_ENV) — on, for local debugging.
 */
export function resolveTrajectoryGate(
	env: NodeJS.ProcessEnv = process.env,
): TrajectoryGateDecision {
	if (env.ELIZA_DISABLE_TRAJECTORY_LOGGING === "1") {
		return { enabled: false, reason: "disable-flag" };
	}

	const explicit = coerceFlag(env.ELIZA_TRAJECTORY_LOGGING);
	if (explicit !== undefined) {
		return { enabled: explicit, reason: "explicit-logging" };
	}

	const legacy = coerceFlag(env.ELIZA_TRAJECTORY_RECORDING);
	if (legacy !== undefined) {
		return { enabled: legacy, reason: "explicit-recording-legacy" };
	}

	if (env.NODE_ENV === "test") {
		return { enabled: false, reason: "test-default-off" };
	}

	if (env.NODE_ENV === "production") {
		return { enabled: false, reason: "production-opt-in" };
	}

	return { enabled: true, reason: "dev-default-on" };
}
