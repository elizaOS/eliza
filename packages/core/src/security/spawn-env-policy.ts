/**
 * Block dangerous env keys from child process spawns (GHSA-54rx class).
 * Shared by shell, MCP, and other spawn paths.
 *
 * The code-injection category is a single source of truth: the agent
 * package's BLOCKED_ENV_KEYS imports these sets directly so the config-write
 * denylist and the spawn sanitizer cannot drift. Both spawn consumers (the
 * coding-tools processQueue and the agent shell-execution-router) now
 * sanitize the FULL merged environment (trusted process.env + untrusted
 * overlay) through the same predicate, closing the config→env→spawn bypass.
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

	// glibc dynamic-linker / locale primitives. GCONV_PATH loads an
	// attacker-supplied charset-conversion shared object into any dynamically
	// linked child — the same dynamic-load class as LD_PRELOAD / LD_AUDIT.
	// The remaining four redirect resolver/message-catalog paths.
	"GCONV_PATH",
	"NLSPATH",
	"HOSTALIASES",
	"RES_OPTIONS",
	"LOCALDOMAIN",

	// Interpreter hijack vars (same class as NODE_OPTIONS/NODE_PATH above):
	// attacker-controlled module paths / auto-run options for spawned
	// python/perl/ruby processes. All are on sudo's default env_delete list.
	"PYTHONPATH",
	"PYTHONSTARTUP",
	"PYTHONHOME",
	// PYTHONUSERBASE relocates the user site-packages directory the interpreter
	// adds to sys.path — same module-path hijack as PYTHONPATH.
	"PYTHONUSERBASE",
	// PYTHONINSPECT drops into interactive mode after running -c; PYTHONWARNINGS
	// expands message filters that can embed arbitrary module references.
	"PYTHONINSPECT",
	"PYTHONWARNINGS",
	"PERL5OPT",
	"PERL5LIB",
	"PERLIO_DEBUG",
	"RUBYOPT",
	"RUBYLIB",
	// GEM_HOME / GEM_PATH load attacker-controlled gems for a spawned ruby;
	// RUBYSHELL overrides the shell ruby uses for backtick execution.
	"GEM_HOME",
	"GEM_PATH",
	"RUBYSHELL",

	// Shell startup / expansion hijack. BASH_ENV is expanded and executed by a
	// non-interactive bash before the requested command. ENV serves the same
	// purpose for non-interactive sh / dash (deliberately excluded below: it
	// could not be made to fire on the test host and sh is not an allowed MCP
	// command). SHELLOPTS + a command-substituting PS4 is a second execution
	// primitive; GLOBIGNORE and IFS rewrite expansion and field splitting.
	"BASH_ENV",
	"SHELLOPTS",
	"PS4",
	"GLOBIGNORE",
	"IFS",

	// JVM: both accept -javaagent:<jar> for bytecode injection; CLASSPATH
	// directs the class loader to attacker-controlled JARs.
	"JAVA_TOOL_OPTIONS",
	"_JAVA_OPTIONS",
	// JDK_JAVA_OPTIONS is prepended to the java launcher's arguments and
	// supports the same -javaagent agent-loading primitive as the vars above.
	"JDK_JAVA_OPTIONS",
	"CLASSPATH",

	// terminfo/termcap: attacker-supplied terminal database can exploit
	// terminal-emulator vulnerabilities in any ncurses/termcap consumer.
	"TERMINFO",
	"TERMINFO_DIRS",
	"TERMCAP",

	// Git: all run external commands with no sandbox.
	// GIT_SSH_COMMAND / GIT_EXTERNAL_DIFF accept a full command line;
	// GIT_SSH substitutes the SSH binary just like GIT_SSH_COMMAND;
	// GIT_ASKPASS executes an arbitrary external program for credential prompts;
	// GIT_CONFIG_COUNT + indexed GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n inject
	// command-bearing git configuration (e.g. core.sshCommand, core.editor).
	"GIT_SSH_COMMAND",
	"GIT_EXTERNAL_DIFF",
	"GIT_SSH",
	"GIT_ASKPASS",
	"GIT_CONFIG_COUNT",

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
	// Indexed git config injection: GIT_CONFIG_KEY_0 / GIT_CONFIG_VALUE_0 etc.
	"GIT_CONFIG_KEY_",
	"GIT_CONFIG_VALUE_",
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
