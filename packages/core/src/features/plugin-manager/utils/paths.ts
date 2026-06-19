import path from "node:path";
import { resolveStateDir, resolveUserPath } from "../../../utils/state-dir.ts";

const CONFIG_FILENAME = "eliza.json";

export { resolveStateDir, resolveUserPath };

export function resolveConfigPath(
	env: NodeJS.ProcessEnv = process.env,
	stateDirPath: string = resolveStateDir(env),
): string {
	const override = env.ELIZA_CONFIG_PATH?.trim();
	if (override) {
		return resolveUserPath(override);
	}
	return path.join(stateDirPath, CONFIG_FILENAME);
}
