import path from "node:path";
import { resolveStateDir } from "@elizaos/core";

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
