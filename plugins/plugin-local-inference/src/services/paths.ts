import { homedir } from "node:os";
import path from "node:path";

function resolveUserPath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, homedir()));
	}
	return path.resolve(trimmed);
}

function resolveStateDir(): string {
	const explicit =
		process.env.ELIZA_STATE_DIR?.trim() || process.env.MILADY_STATE_DIR?.trim();
	if (explicit) return resolveUserPath(explicit);
	const namespace = process.env.ELIZA_NAMESPACE?.trim() || "eliza";
	return path.join(homedir(), `.${namespace}`);
}

export function localInferenceRoot(): string {
	return path.join(resolveStateDir(), "local-inference");
}

export function elizaModelsDir(): string {
	return path.join(localInferenceRoot(), "models");
}

export function registryPath(): string {
	return path.join(localInferenceRoot(), "registry.json");
}

export function downloadsStagingDir(): string {
	return path.join(localInferenceRoot(), "downloads");
}

export function isWithinElizaRoot(target: string): boolean {
	const root = path.resolve(localInferenceRoot());
	const resolved = path.resolve(target);
	if (resolved === root) return false;
	return resolved.startsWith(`${root}${path.sep}`);
}
