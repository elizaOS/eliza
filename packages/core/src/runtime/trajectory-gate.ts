/**
 * Single on/off resolver for trajectory persistence, consulted by both the
 * file recorder (`isTrajectoryRecordingEnabled`, trajectory-recorder.ts) and
 * the DB logger (`shouldEnableTrajectoryLoggingByDefault`,
 * agent/trajectory-internals.ts) so both recorders apply one policy (#13775).
 *
 * The policy encodes SOC2 O-5 (production is opt-in, never on by default) and a
 * test default of off (keeps the test runner free of background trajectory
 * writes). `ELIZA_TRAJECTORY_LOGGING` is the canonical operator knob;
 * `ELIZA_TRAJECTORY_RECORDING` is the legacy alias the file recorder used and
 * is honored for back-compat. When neither explicit knob is set the NODE_ENV
 * defaults apply. A host in a protected (confidential) profile —
 * `ELIZA_PROTECTED_PROFILE` non-empty — defaults off regardless of NODE_ENV so
 * nothing is persisted unless the operator opts in inside the TEE. Core reads
 * the env var directly; validation of the profile value belongs to the host.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Coerce a raw env value to a boolean. Returns undefined when the var is unset
 * or blank/whitespace-only — a set-but-empty entry (an empty `.env` line,
 * `ELIZA_TRAJECTORY_LOGGING=`) is treated as unset so the caller falls through
 * to the next precedence tier rather than reading as an explicit opt-out, per
 * the repo's blank-is-unset env contract (`presentEnvValue`, boot-env.ts;
 * #13802). A set, non-blank, non-truthy value ("0"/"false"/…) is an explicit
 * opt-out and coerces to false.
 */
function coerceFlag(raw: string | undefined): boolean | undefined {
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	return TRUTHY.has(trimmed.toLowerCase());
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
 *   4. `ELIZA_PROTECTED_PROFILE` non-empty — off (protected deployments never
 *      persist trajectories by default; operators may opt in via tier 2/3).
 *   5. `NODE_ENV=test` — off (no background writes during tests).
 *   6. `NODE_ENV=production` — off (SOC2 O-5: operators must opt in via tier 2).
 *   7. otherwise (dev / unset NODE_ENV) — on, for local debugging.
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

	if ((env.ELIZA_PROTECTED_PROFILE ?? "").trim() !== "") {
		return { enabled: false, reason: "protected-profile-default-off" };
	}

	if (env.NODE_ENV === "test") {
		return { enabled: false, reason: "test-default-off" };
	}

	if (env.NODE_ENV === "production") {
		return { enabled: false, reason: "production-opt-in" };
	}

	return { enabled: true, reason: "dev-default-on" };
}
