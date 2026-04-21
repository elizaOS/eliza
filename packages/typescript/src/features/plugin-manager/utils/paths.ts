import os from "node:os";
import path from "node:path";

const STATE_DIRNAME = ".eliza";
const CONFIG_FILENAME = "eliza.json";

function stateDir(homedir: () => string = os.homedir): string {
	return path.join(homedir(), STATE_DIRNAME);
}

export function resolveUserPath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) {
		return trimmed;
	}
	if (trimmed.startsWith("~")) {
		const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
		return path.resolve(expanded);
	}
	return path.resolve(trimmed);
}

export function resolveStateDir(
	env: NodeJS.ProcessEnv = process.env,
	homedir: () => string = os.homedir,
): string {
	const override = env.ELIZA_STATE_DIR?.trim();
	if (override) {
		return resolveUserPath(override);
	}
	return stateDir(homedir);
}

export function resolveConfigPath(
	env: NodeJS.ProcessEnv = process.env,
	stateDirPath: string = resolveStateDir(env, os.homedir),
): string {
	const override = env.ELIZA_CONFIG_PATH?.trim();
	if (override) {
		return resolveUserPath(override);
	}
	return path.join(stateDirPath, CONFIG_FILENAME);
}
