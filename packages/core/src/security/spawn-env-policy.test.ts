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
});
