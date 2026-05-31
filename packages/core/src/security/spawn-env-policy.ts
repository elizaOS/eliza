/**
 * Block dangerous env keys from child process spawns (GHSA-54rx class).
 * Shared by shell, MCP, and other spawn paths.
 */

const BLOCKED_SPAWN_ENV_KEYS = new Set([
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"NODE_OPTIONS",
	"NODE_EXTRA_CA_CERTS",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"NODE_PATH",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"CURL_CA_BUNDLE",
	"PATH",
	"HOME",
	"SHELL",
]);

const BLOCKED_SPAWN_ENV_PREFIXES = [
	"NPM_CONFIG_",
	"PNPM_",
	"YARN_",
	"BUN_CONFIG_",
	"UV_",
	"PIP_",
	"PIPX_",
	"PYX_",
	"DENO_",
	"DOCKER_",
	"PODMAN_",
	"BASH_FUNC_",
] as const;

export function isBlockedSpawnEnvKey(key: string): boolean {
	const upper = key.toUpperCase();
	if (BLOCKED_SPAWN_ENV_KEYS.has(upper)) {
		return true;
	}
	return BLOCKED_SPAWN_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function sanitizeSpawnEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(env)) {
		if (isBlockedSpawnEnvKey(key)) {
			continue;
		}
		out[key] = value;
	}
	return out;
}
