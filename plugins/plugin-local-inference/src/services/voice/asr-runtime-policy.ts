/**
 * Normalizes the fused ASR accelerator setting before native code reads its C
 * process environment. Apple-silicon ASR stays on the correctness-proven CPU
 * path until the Metal audio projector passes transcript parity, while valid
 * operator overrides remain explicit and invalid overrides fail closed.
 */

const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

export class AsrRuntimePolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AsrRuntimePolicyError";
	}
}

export function resolveAsrRuntimeSetting(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): "0" | "1" | null {
	const raw = env.ELIZA_ASR_USE_GPU;
	if (raw === undefined) {
		return platform === "darwin" && arch === "arm64" ? "0" : null;
	}
	const normalized = raw.trim().toLowerCase();
	const value = ENABLED_VALUES.has(normalized)
		? "1"
		: DISABLED_VALUES.has(normalized)
			? "0"
			: null;
	if (value === null) {
		throw new AsrRuntimePolicyError(
			"ELIZA_ASR_USE_GPU must be one of 1/true/yes/on or 0/false/no/off",
		);
	}
	if (platform === "darwin" && arch === "arm64") return value;
	return null;
}
