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
		// dynamic linker
		"LD_AUDIT",
		"ld_audit",
		"DYLD_FRAMEWORK_PATH",
		// glibc locale/resolver
		"GCONV_PATH",
		"NLSPATH",
		"HOSTALIASES",
		"RES_OPTIONS",
		"LOCALDOMAIN",
		// Python
		"PYTHONPATH",
		"PYTHONSTARTUP",
		"PYTHONHOME",
		"PYTHONUSERBASE",
		"PYTHONINSPECT",
		"PYTHONWARNINGS",
		// Perl
		"PERL5OPT",
		"PERL5LIB",
		"PERLIO_DEBUG",
		// Ruby
		"RUBYOPT",
		"RUBYLIB",
		"GEM_HOME",
		"GEM_PATH",
		"RUBYSHELL",
		// Shell startup/expansion
		"BASH_ENV",
		"SHELLOPTS",
		"PS4",
		"GLOBIGNORE",
		"IFS",
		"ZDOTDIR",
		// JVM
		"JAVA_TOOL_OPTIONS",
		"_JAVA_OPTIONS",
		"JDK_JAVA_OPTIONS",
		"CLASSPATH",
		// terminfo/termcap
		"TERMINFO",
		"TERMINFO_DIRS",
		"TERMCAP",
		// Git external commands
		"GIT_SSH_COMMAND",
		"GIT_EXTERNAL_DIFF",
		"GIT_SSH",
		"GIT_ASKPASS",
		"GIT_CONFIG_COUNT",
		"GIT_CONFIG_KEY_0",
		"GIT_CONFIG_VALUE_0",
	])("blocks %s", (key) => {
		expect(isBlockedSpawnEnvKey(key)).toBe(true);
	});

	it("still blocks the original loader keys", () => {
		expect(isBlockedSpawnEnvKey("LD_PRELOAD")).toBe(true);
		expect(isBlockedSpawnEnvKey("NODE_OPTIONS")).toBe(true);
	});

	it("does not block ordinary application keys", () => {
		expect(isBlockedSpawnEnvKey("NODE_ENV")).toBe(false);
		expect(isBlockedSpawnEnvKey("ENVIRONMENT")).toBe(false);
		expect(isBlockedSpawnEnvKey("TERM")).toBe(false);
		expect(isBlockedSpawnEnvKey("GIT_AUTHOR_NAME")).toBe(false);
		expect(isBlockedSpawnEnvKey("ENV")).toBe(false);
		expect(isBlockedSpawnEnvKey("LANG")).toBe(false);
		expect(isBlockedSpawnEnvKey("MY_APP_SETTING")).toBe(false);
		expect(isBlockedSpawnEnvKey("TZ")).toBe(false);
		// Lookalikes that must NOT be blocked
		expect(isBlockedSpawnEnvKey("PYTHON_VERSION")).toBe(false);
		expect(isBlockedSpawnEnvKey("RUBY_VERSION")).toBe(false);
		expect(isBlockedSpawnEnvKey("GIT_AUTHOR_NAME")).toBe(false);
		expect(isBlockedSpawnEnvKey("GIT_COMMITTER_NAME")).toBe(false);
		expect(isBlockedSpawnEnvKey("GIT_TERMINAL_PROMPT")).toBe(false);
	});
});

describe("sanitizeSpawnEnv", () => {
	it("drops all injection-primitive keys but keeps benign keys", () => {
		const out = sanitizeSpawnEnv({
			LD_AUDIT: "/tmp/evil.so",
			GCONV_PATH: "/tmp/evil-gconv",
			PYTHONPATH: "/tmp/evil-modules",
			PYTHONUSERBASE: "/tmp/evil-userbase",
			BASH_ENV: "/tmp/evil-hook.sh",
			GEM_HOME: "/tmp/evil-gems",
			CLASSPATH: "/tmp/evil.jar",
			GIT_SSH_COMMAND: "/tmp/evil-ssh",
			IFS: " ",
			RUBYOPT: "-r/tmp/evil",
			MY_APP_SETTING: "ok",
			LANG: "en_US.UTF-8",
			NODE_ENV: "production",
			GIT_AUTHOR_NAME: "test",
		});
		expect(out).toEqual({
			MY_APP_SETTING: "ok",
			LANG: "en_US.UTF-8",
			NODE_ENV: "production",
			GIT_AUTHOR_NAME: "test",
		});
	});

	it("drops equivalent JVM and Git injection primitives added in review", () => {
		const out = sanitizeSpawnEnv({
			JDK_JAVA_OPTIONS: "-javaagent:/tmp/evil.jar",
			GIT_SSH: "/tmp/evil-ssh",
			GIT_ASKPASS: "/tmp/evil-askpass",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.sshCommand",
			GIT_CONFIG_VALUE_0: "/tmp/evil-cmd",
			SAFE_KEY: "ok",
		});
		expect(out).toEqual({ SAFE_KEY: "ok" });
	});
});
