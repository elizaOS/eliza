/**
 * Block dangerous env keys from child process spawns (GHSA-54rx class).
 * Shared by shell, MCP, and other spawn paths.
 */

/**
 * Single source of truth for the spawn/MCP env denylist. Consumers that need
 * the raw data (e.g. the agent's MCP config validator) import these directly so
 * the lists cannot drift between the shell/spawn and MCP paths.
 */
export const BLOCKED_SPAWN_ENV_KEYS: ReadonlySet<string> = new Set([
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	// ld.so audit hook: loads an arbitrary shared object into every spawned
	// dynamically linked binary — same code-injection primitive as LD_PRELOAD.
	"LD_AUDIT",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FRAMEWORK_PATH",
	// Interpreter hijack vars (same class as NODE_OPTIONS/NODE_PATH above):
	// attacker-controlled module paths / auto-run options for spawned
	// python/perl/ruby processes. All are on sudo's default env_delete list.
	"PYTHONPATH",
	"PYTHONSTARTUP",
	"PYTHONHOME",
	"PERL5OPT",
	"PERL5LIB",
	"RUBYOPT",
	"RUBYLIB",
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
	// Shell startup hooks, for the exported sanitizeSpawnEnv/runShell surface and
	// for any allowed command that itself spawns a shell. A non-interactive bash
	// reads BASH_ENV, expands it, and EXECUTES that file before the requested
	// command — the same arbitrary-code primitive BASH_FUNC_ below defends
	// against. SHELLOPTS=xtrace plus a command-substituting PS4 is a second
	// execution primitive, and GLOBIGNORE and IFS rewrite expansion and field
	// splitting under the command.
	"BASH_ENV",
	"SHELLOPTS",
	"PS4",
	"GLOBIGNORE",
	"IFS",
	// JVM option/agent injection: both are read before main() and accept
	// `-javaagent`, the Java equivalent of LD_PRELOAD. CLASSPATH is the Java
	// module-path hijack that mirrors the blocked PYTHONPATH/RUBYLIB above.
	"JAVA_TOOL_OPTIONS",
	"_JAVA_OPTIONS",
	"CLASSPATH",
	// glibc loader/resolver hooks, all on sudo's env_delete list. GCONV_PATH loads
	// an attacker-supplied charset conversion module; the resolver vars redirect
	// name resolution for the spawned process.
	"GCONV_PATH",
	"NLSPATH",
	"HOSTALIASES",
	"RES_OPTIONS",
	"LOCALDOMAIN",
	// Remaining interpreter hijacks whose siblings are already blocked above.
	// The Python three matter most directly: `python`/`python3` are on the MCP
	// validator's ALLOWED_MCP_COMMANDS, so a config that names them is spawned
	// with whatever env survives this list.
	"PYTHONINSPECT",
	"PYTHONUSERBASE",
	"PYTHONWARNINGS",
	"PERLIO_DEBUG",
	"GEM_HOME",
	"GEM_PATH",
	"RUBYSHELL",
	// terminfo/termcap descriptions are compiled data the terminal library loads
	// from an attacker-chosen directory.
	"TERMINFO",
	"TERMINFO_DIRS",
	"TERMCAP",
	// git runs these as commands: GIT_SSH_COMMAND on every transport operation and
	// GIT_EXTERNAL_DIFF on every diff, so either turns a routine git call into
	// arbitrary execution.
	"GIT_SSH_COMMAND",
	"GIT_EXTERNAL_DIFF",
]);

export const BLOCKED_SPAWN_ENV_PREFIXES = [
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
