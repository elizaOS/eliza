/**
 * The spawn env denylist is the only thing standing between attacker-supplied
 * env (MCP server config, shell spawns) and code injection into every child
 * process. The loader/interpreter hijack keys it blocks are the same primitive
 * as the long-blocked LD_PRELOAD / NODE_OPTIONS: they make the dynamic linker or
 * a spawned python/perl/ruby load attacker-controlled code.
 */

import { describe, expect, it } from "vitest";
import { isBlockedSpawnEnvKey, sanitizeSpawnEnv } from "./spawn-env-policy.ts";

describe("isBlockedSpawnEnvKey (loader/interpreter hijack keys)", () => {
	it.each([
		"LD_AUDIT",
		"ld_audit",
		"DYLD_FRAMEWORK_PATH",
		"PYTHONPATH",
		"PYTHONSTARTUP",
		"PYTHONHOME",
		"PERL5OPT",
		"PERL5LIB",
		"RUBYOPT",
		"RUBYLIB",
	])("blocks %s", (key) => {
		expect(isBlockedSpawnEnvKey(key)).toBe(true);
	});

	it("still blocks the original loader keys", () => {
		expect(isBlockedSpawnEnvKey("LD_PRELOAD")).toBe(true);
		expect(isBlockedSpawnEnvKey("NODE_OPTIONS")).toBe(true);
	});

	it("does not block ordinary application keys", () => {
		expect(isBlockedSpawnEnvKey("LANG")).toBe(false);
		expect(isBlockedSpawnEnvKey("MY_APP_SETTING")).toBe(false);
		expect(isBlockedSpawnEnvKey("TZ")).toBe(false);
	});
});

describe("isBlockedSpawnEnvKey (shell startup hooks)", () => {
	// A non-interactive bash executes the file named by BASH_ENV before the
	// requested command, and this router spawns `sh`/`bash` with `-c`. SHELLOPTS
	// + PS4 is the second execution primitive: xtrace command-substitutes PS4 on
	// every traced line.
	it.each(["BASH_ENV", "bash_env", "SHELLOPTS", "PS4", "GLOBIGNORE", "IFS"])(
		"blocks %s",
		(key) => {
			expect(isBlockedSpawnEnvKey(key)).toBe(true);
		},
	);

	// ENV is deliberately NOT blocked: it is a plausible generic application
	// variable, `sh` is not an allowed MCP command, and a rejected MCP env is a
	// fatal startup error rather than a silent drop.
	it("leaves the generic ENV variable alone", () => {
		expect(isBlockedSpawnEnvKey("ENV")).toBe(false);
	});
});

describe("isBlockedSpawnEnvKey (runtime/loader hijacks on sudo's env_delete list)", () => {
	it.each([
		"JAVA_TOOL_OPTIONS",
		"_JAVA_OPTIONS",
		"CLASSPATH",
		"GCONV_PATH",
		"NLSPATH",
		"HOSTALIASES",
		"RES_OPTIONS",
		"LOCALDOMAIN",
		"PYTHONINSPECT",
		"PYTHONUSERBASE",
		"PYTHONWARNINGS",
		"PERLIO_DEBUG",
		"GEM_HOME",
		"GEM_PATH",
		"RUBYSHELL",
		"TERMINFO",
		"TERMINFO_DIRS",
		"TERMCAP",
		"GIT_SSH_COMMAND",
		"GIT_EXTERNAL_DIFF",
	])("blocks %s", (key) => {
		expect(isBlockedSpawnEnvKey(key)).toBe(true);
	});
});

describe("isBlockedSpawnEnvKey (git config injection)", () => {
	it.each([
		"GIT_CONFIG_COUNT",
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM",
		"git_config_global",
		"GIT_CONFIG_KEY_0",
		"GIT_CONFIG_VALUE_0",
		"GIT_CONFIG_KEY_17",
		"GIT_CONFIG_VALUE_17",
	])("blocks %s", (key) => {
		expect(isBlockedSpawnEnvKey(key)).toBe(true);
	});

	it("leaves benign git keys and prefix lookalikes alone", () => {
		expect(isBlockedSpawnEnvKey("GIT_AUTHOR_NAME")).toBe(false);
		expect(isBlockedSpawnEnvKey("GIT_COMMITTER_NAME")).toBe(false);
		expect(isBlockedSpawnEnvKey("GIT_TERMINAL_PROMPT")).toBe(false);
		// Shares ten characters with the prefix; the trailing underscore is what
		// makes GIT_CONFIG_ a namespace, so this must not match.
		expect(isBlockedSpawnEnvKey("GIT_CONFIGURATION")).toBe(false);
		// Bare GIT_CONFIG does not resolve aliases, so it is not listed.
		expect(isBlockedSpawnEnvKey("GIT_CONFIG")).toBe(false);
	});
});

describe("sanitizeSpawnEnv", () => {
	it("drops LD_AUDIT / PYTHONPATH but keeps benign keys", () => {
		const out = sanitizeSpawnEnv({
			LD_AUDIT: "/tmp/evil.so",
			PYTHONPATH: "/tmp/evil-modules",
			RUBYOPT: "-r/tmp/evil",
			MY_APP_SETTING: "ok",
			LANG: "en_US.UTF-8",
		});
		expect(out).toEqual({ MY_APP_SETTING: "ok", LANG: "en_US.UTF-8" });
	});

	it("drops shell-startup and runtime hijack keys from a spawn env", () => {
		const out = sanitizeSpawnEnv({
			BASH_ENV: "/tmp/evil.sh",
			SHELLOPTS: "xtrace",
			PS4: "$(/tmp/evil)",
			IFS: ",",
			JAVA_TOOL_OPTIONS: "-javaagent:/tmp/evil.jar",
			GCONV_PATH: "/tmp/evil-gconv",
			GIT_SSH_COMMAND: "/tmp/evil.sh",
			MY_APP_SETTING: "ok",
			LANG: "en_US.UTF-8",
		});
		expect(out).toEqual({ MY_APP_SETTING: "ok", LANG: "en_US.UTF-8" });
	});

	it("drops the git config injection family but keeps benign git keys", () => {
		const out = sanitizeSpawnEnv({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.sshCommand",
			GIT_CONFIG_VALUE_0: "sh -c 'id>/tmp/pwned'",
			GIT_CONFIG_GLOBAL: "/tmp/evil.gitconfig",
			GIT_CONFIG_SYSTEM: "/tmp/evil.gitconfig",
			GIT_AUTHOR_NAME: "ok",
			LANG: "en_US.UTF-8",
		});
		expect(out).toEqual({ GIT_AUTHOR_NAME: "ok", LANG: "en_US.UTF-8" });
	});

	it("still allows ordinary application keys that only look shell-adjacent", () => {
		expect(isBlockedSpawnEnvKey("ENVIRONMENT")).toBe(false);
		expect(isBlockedSpawnEnvKey("NODE_ENV")).toBe(false);
		expect(isBlockedSpawnEnvKey("TERM")).toBe(false);
		expect(isBlockedSpawnEnvKey("GIT_AUTHOR_NAME")).toBe(false);
	});
});
