/**
 * Agent Plugins 1.0.0 plugin name constraints (§5.5).
 */

export function isValidPluginName(name: string): boolean {
	if (name.length < 1 || name.length > 64) return false;
	if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return false;
	if (!/^[a-z0-9.-]+$/.test(name)) return false;
	if (name.includes("--") || name.includes("..")) return false;
	return true;
}

export function pluginNameError(name: unknown): string | null {
	if (typeof name !== "string") return "name must be a string";
	if (name.length < 1) return "name must be 1-64 characters";
	if (name.length > 64) return "name must be 1-64 characters";
	if (!isValidPluginName(name)) {
		return "name must be [a-z0-9.-], start/end alphanumeric, no -- or ..";
	}
	return null;
}
