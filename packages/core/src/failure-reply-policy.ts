/**
 * Failure-reply policy: where a canned "generation failed / timed out" reply
 * may be posted when a turn dies before producing an answer.
 *
 * The connector and the core message service both synthesize short failure
 * texts ("I timed out while generating that reply. Please retry.", the
 * structured rate-limit apology, ...) when the model path fails. In a DM the
 * user is alone with the agent, so silence reads as a hang and the notice is
 * the kinder outcome. In a public room (guild channel, thread, group) the
 * same notice is noise: every reader sees the outage, nobody can act on it,
 * and a multi-hour provider incident turns into a wall of identical apologies
 * (observed live: five "I timed out" posts into a shared Discord channel
 * during a 29h broker outage). The public failure signal is the error
 * reaction / typing stop, not text.
 *
 * `FAILURE_REPLY_POLICY` (runtime setting, env fallback):
 *   - `dm-only` (default): failure text only in DM / API / SELF style rooms
 *     and on autonomous turns; public rooms stay silent.
 *   - `all`: legacy behavior, failure text everywhere it was previously sent.
 *   - `off`: never post failure text; rely on reactions / logs alone.
 *
 * Unrecognized values fail closed to `dm-only` and are logged once per
 * process so a typo in config does not silently re-enable public spam.
 */

export const FAILURE_REPLY_POLICIES = ["dm-only", "all", "off"] as const;
export type FailureReplyPolicy = (typeof FAILURE_REPLY_POLICIES)[number];
export const DEFAULT_FAILURE_REPLY_POLICY: FailureReplyPolicy = "dm-only";
export const FAILURE_REPLY_POLICY_SETTING = "FAILURE_REPLY_POLICY";

type SettingsReader = {
	getSetting?: (key: string) => unknown;
};

type EnvLike = Record<string, string | undefined>;

type PolicyLogger = {
	warn?: (context: Record<string, unknown>, message: string) => void;
};

function defaultEnv(): EnvLike {
	const globalWithProcess = globalThis as {
		process?: { env?: EnvLike };
	};
	return globalWithProcess.process?.env ?? {};
}

const warnedInvalidValues = new Set<string>();

/** Test-only: forget which invalid values have already been logged. */
export function resetFailureReplyPolicyWarnings(): void {
	warnedInvalidValues.clear();
}

/**
 * Normalize a raw setting value into a policy. Accepts a few obvious aliases
 * (`dm`, `dms`, `private`, `always`, `everywhere`, `none`, `never`, `silent`)
 * so the setting is forgiving without being ambiguous. Anything else returns
 * `null` so the caller can log and fall back.
 */
export function parseFailureReplyPolicy(
	value: unknown,
): FailureReplyPolicy | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase().replace(/_/g, "-");
	if (normalized === "") return null;
	switch (normalized) {
		case "dm-only":
		case "dm":
		case "dms":
		case "private":
			return "dm-only";
		case "all":
		case "always":
		case "everywhere":
			return "all";
		case "off":
		case "none":
		case "never":
		case "silent":
			return "off";
		default:
			return null;
	}
}

/**
 * Resolve the effective policy from the runtime setting first, then the
 * process env, then the default. Invalid values fail closed to `dm-only` and
 * are reported once per distinct value.
 */
export function resolveFailureReplyPolicy(
	runtime?: SettingsReader | null,
	options: { env?: EnvLike; logger?: PolicyLogger } = {},
): FailureReplyPolicy {
	const env = options.env ?? defaultEnv();
	const raw =
		runtime?.getSetting?.(FAILURE_REPLY_POLICY_SETTING) ??
		env[FAILURE_REPLY_POLICY_SETTING];
	if (raw === undefined || raw === null || raw === "") {
		return DEFAULT_FAILURE_REPLY_POLICY;
	}
	const parsed = parseFailureReplyPolicy(raw);
	if (parsed) return parsed;
	const key = String(raw);
	if (!warnedInvalidValues.has(key)) {
		warnedInvalidValues.add(key);
		options.logger?.warn?.(
			{
				src: "core:failure-reply-policy",
				setting: FAILURE_REPLY_POLICY_SETTING,
				value: key,
				fallback: DEFAULT_FAILURE_REPLY_POLICY,
				accepted: FAILURE_REPLY_POLICIES,
			},
			"Unrecognized FAILURE_REPLY_POLICY value; failing closed to dm-only",
		);
	}
	return DEFAULT_FAILURE_REPLY_POLICY;
}

/**
 * Room kinds where the user is effectively alone with the agent. A failure
 * notice there is a courtesy, not a broadcast. Matches the core
 * always-respond channel set plus voice DMs.
 */
const PRIVATE_CHANNEL_TYPES: ReadonlySet<string> = new Set([
	"DM",
	"VOICE_DM",
	"SELF",
	"API",
]);

/** True when the given core `ChannelType` string is a private (1:1) room. */
export function isPrivateFailureReplyChannel(
	channelType: string | null | undefined,
): boolean {
	if (!channelType) return false;
	return PRIVATE_CHANNEL_TYPES.has(String(channelType).trim().toUpperCase());
}

export interface ShouldEmitFailureReplyArgs {
	policy: FailureReplyPolicy;
	/**
	 * Explicit privacy verdict. When provided it wins over `channelType`.
	 * Connectors that know their transport (Discord DM vs guild channel) pass
	 * this directly.
	 */
	isDm?: boolean;
	/** Core `ChannelType` of the room, used when `isDm` is not supplied. */
	channelType?: string | null;
	/**
	 * Autonomous / self-driven turns have no human audience to spam; they keep
	 * the failure text under `dm-only` so the autonomy loop can see it.
	 */
	isAutonomous?: boolean;
}

export type FailureReplySuppressionReason =
	| "policy-off"
	| "policy-dm-only-public-room";

export interface FailureReplyDecision {
	emit: boolean;
	reason?: FailureReplySuppressionReason;
}

/**
 * Decide whether a canned failure reply may be posted for this turn.
 *
 * - `all`: always emit.
 * - `off`: never emit.
 * - `dm-only`: emit only when the room is private (`isDm` / private
 *   `channelType`) or the turn is autonomous. Unknown room kind with no
 *   `isDm` hint is treated as PUBLIC (fail closed: silence is the safe
 *   default when we cannot prove the audience is one person).
 */
export function shouldEmitFailureReply(
	args: ShouldEmitFailureReplyArgs,
): FailureReplyDecision {
	if (args.policy === "all") return { emit: true };
	if (args.policy === "off") return { emit: false, reason: "policy-off" };
	if (args.isAutonomous) return { emit: true };
	const privateRoom =
		typeof args.isDm === "boolean"
			? args.isDm
			: isPrivateFailureReplyChannel(args.channelType);
	if (privateRoom) return { emit: true };
	return { emit: false, reason: "policy-dm-only-public-room" };
}
