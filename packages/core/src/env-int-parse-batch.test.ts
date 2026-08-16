/**
 * Pins Ship 16 env-int parse batch (CO-3):
 * - MCP 7 sites (MCP_TIMEOUT 60, SSE_MAX_DURATION 300, POLL 500, HEARTBEAT 30, MAX_CONNS 10, BACKOFF_INIT 500, BACKOFF_MAX 5000)
 * - ANON_HOURLY_LIMIT 10
 * - Discord channelDebounceMs 3000 and recentContextTtlMs 90000
 * All used `Number.parseInt(...||"fallback",10)` or `parseInt(... )||fallback` without Number+isFinite+isInteger, causing `0→fallback`, `5junk→5` vs fallback, `abc→NaN` vs fallback, `1e3→1` prefix.
 *
 * Sibling correct: `packages/agent/src/runtime/operations/repository.ts:42` `readEnvNumber` with `Number(raw)` + `isFinite` + `>=0`, `memory-retention.ts:214` `positiveNumberOrUndefined`, `runtime-env.ts:198` `parsePositivePort`.
 */

import { describe, expect, it } from "vitest";

function oldEnvIntMcp(rawEnv: string | undefined, fallbackStr: string): number {
	// pre-parse || fallback then parseInt
	return Number.parseInt(rawEnv || fallbackStr, 10);
}
function oldAnon(rawEnv: string | undefined): number {
	return Number.parseInt(rawEnv || "10", 10);
}
function oldDiscordSetting(
	raw: string | number | undefined,
	fallback: number,
): number {
	if (typeof raw === "number") return raw;
	if (typeof raw === "string" && raw.trim())
		return Number.parseInt(raw, 10) || fallback;
	return fallback;
}
function fixedEnvInt(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const n = Number(raw.trim());
	return Number.isInteger(n) && Number.isFinite(n) && n >= 0 ? n : fallback;
}
function fixedDiscordSetting(
	raw: string | number | undefined,
	fallback: number,
): number {
	if (typeof raw === "number")
		return Number.isInteger(raw) && Number.isFinite(raw) && raw >= 0
			? raw
			: fallback;
	if (typeof raw === "string") {
		const t = raw.trim();
		if (!t) return fallback;
		const n = Number(t);
		return Number.isInteger(n) && Number.isFinite(n) && n >= 0 ? n : fallback;
	}
	return fallback;
}

describe("env int parse batch (ship 16) — CO-3", () => {
	it("MCP pre-parse ||: old NaN flows vs fixed fallback, junk prefix vs fallback, 0 preserved", () => {
		// env="abc" → pre-parse: parseInt("abc"||"60") = parseInt("abc")=NaN → flows as NaN (BUG, should fallback 60)
		expect(oldEnvIntMcp("abc", "60")).toBeNaN();
		expect(fixedEnvInt("abc", 60)).toBe(60);
		// env="5junk" → parseInt("5junk")=5 vs fixed fallback
		expect(oldEnvIntMcp("5junk", "60")).toBe(5);
		expect(fixedEnvInt("5junk", 60)).toBe(60);
		// env="1e3" parseInt prefix →1 vs fallback (Number("1e3")=1000 but isInteger true? For env int, 1e3 is 1000 scientific, Number accepts, but parseInt "1e3"→1 junk prefix, fixed would accept 1000? Wait Number("1e3")=1000 integer, so fixed would accept 1000 not fallback. But we want strict integer with no exponential? Hunt says 1e3→1 vs fallback, but fixed fallback should be? Actually sibling readEnvNumber uses Number("1e3")→1000 valid, not fallback. So we align with Number discipline: fixed of "1e3" would be 1000, not fallback. Our fixed currently would accept 1000 as valid, while old gives 1. That's still divergence, both not pure fallback. We test that old is 1 and fixed is 1000 (different from old, not fallback). For comparison we assert old 1 vs fixed 1000 to show payload divergence.
		expect(oldEnvIntMcp("1e3", "60")).toBe(1);
		expect(fixedEnvInt("1e3", 60)).toBe(1000);
		// env="0" valid zero should be preserved (both preserve for pre-parse sites: old 0 vs fixed 0)
		expect(oldEnvIntMcp("0", "60")).toBe(0);
		expect(fixedEnvInt("0", 60)).toBe(0);
		// env undefined → old uses fallback string
		expect(oldEnvIntMcp(undefined, "60")).toBe(60);
		expect(fixedEnvInt(undefined, 60)).toBe(60);
	});

	it("ANON_HOURLY_LIMIT same class", () => {
		expect(oldAnon("abc")).toBeNaN();
		expect(fixedEnvInt("abc", 10)).toBe(10);
		expect(oldAnon("5junk")).toBe(5);
		expect(fixedEnvInt("5junk", 10)).toBe(10);
		expect(oldAnon("0")).toBe(0);
		expect(fixedEnvInt("0", 10)).toBe(0);
	});

	it("Discord post-parse ||: old 0→fallback, 5junk→5, abc→fallback, 1e3→1 vs strict", () => {
		// old: Number.parseInt("0",10)=0 ||3000 →3000 (BUG valid 0 lost)
		expect(oldDiscordSetting("0", 3000)).toBe(3000);
		expect(fixedDiscordSetting("0", 3000)).toBe(0);
		expect(oldDiscordSetting("5junk", 3000)).toBe(5);
		expect(fixedDiscordSetting("5junk", 3000)).toBe(3000);
		expect(oldDiscordSetting("abc", 3000)).toBe(3000);
		expect(fixedDiscordSetting("abc", 3000)).toBe(3000);
		// old: "1e3"→1 vs fixed 1000
		expect(oldDiscordSetting("1e3", 3000)).toBe(1);
		expect(fixedDiscordSetting("1e3", 3000)).toBe(1000);
		// numeric 0 valid, old preserves (number branch bypasses ||)
		expect(oldDiscordSetting(0, 3000)).toBe(0);
		expect(fixedDiscordSetting(0, 3000)).toBe(0);
		expect(oldDiscordSetting(90000, 90000)).toBe(90000);
		expect(fixedDiscordSetting(90000, 90000)).toBe(90000);
		expect(oldDiscordSetting("  5000  ", 3000)).toBe(5000);
		expect(fixedDiscordSetting("  5000  ", 3000)).toBe(5000);
	});

	it("ship16 sibling proof: files use envInt/parseSettingInt with Number+isInteger+isFinite, not bare parseInt||", async () => {
		const fs = await import("node:fs");
		const mcp = fs.readFileSync(
			"packages/cloud/shared/src/lib/config/mcp.ts",
			"utf8",
		);
		expect(mcp).toContain("function envInt");
		expect(mcp).toContain("Number.isInteger");
		expect(mcp).toContain("Number.isFinite");
		expect(mcp).toContain('envInt("MCP_TIMEOUT", 60)');
		expect(mcp).toContain('envInt("SSE_MAX_DURATION", 300)');
		expect(mcp).toContain('envInt("SSE_MAX_CONNECTIONS_PER_ORG", 10)');
		expect(mcp).not.toContain("Number.parseInt(process.env.MCP_TIMEOUT");
		expect(mcp).not.toContain("Number.parseInt(process.env.SSE_MAX_DURATION");

		const anon = fs.readFileSync(
			"packages/cloud/shared/src/lib/auth-anonymous.ts",
			"utf8",
		);
		expect(anon).toContain("function anonHourlyLimit");
		expect(anon).toContain("Number.isInteger");
		expect(anon).not.toContain("Number.parseInt(process.env.ANON_HOURLY_LIMIT");

		const disc = fs.readFileSync(
			"plugins/plugin-discord/discord-events.ts",
			"utf8",
		);
		expect(disc).toContain("function parseSettingInt");
		expect(disc).toContain("parseSettingInt(channelDebounceMsSetting, 3000)");
		expect(disc).toContain("parseSettingInt(recentContextTtlMsSetting, 90000)");
		expect(disc).not.toContain("Number.parseInt(channelDebounceMsSetting");
		expect(disc).not.toContain("|| 3000");
		expect(disc).not.toContain("|| 90000");
	});
});
