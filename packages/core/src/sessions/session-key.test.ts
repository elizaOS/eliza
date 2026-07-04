/**
 * Session keys (`agent:{agentId}:{rest}`) identify sessions, threads, and peer
 * connections. Build/parse must round-trip, IDs must be normalized path-safe,
 * and thread/ACP/subagent discriminators must be parsed correctly — a wrong key
 * routes a message to the wrong session.
 */
import { describe, expect, it } from "vitest";
import {
	buildAcpSessionKey,
	buildAgentMainSessionKey,
	buildAgentSessionKey,
	buildSubagentSessionKey,
	isAcpSessionKey,
	isSubagentSessionKey,
	normalizeAccountId,
	normalizeAgentId,
	normalizeMainKey,
	parseAgentSessionKey,
	resolveThreadParentSessionKey,
	sanitizeAgentId,
} from "./session-key.ts";

describe("build + parse round-trip", () => {
	it("builds lowercased keys and parses them back", () => {
		expect(buildAgentSessionKey("Agent1", "Main")).toBe("agent:agent1:main");
		expect(buildAgentMainSessionKey({ agentId: "Bot" })).toBe("agent:bot:main");

		const parsed = parseAgentSessionKey("agent:bot:main");
		expect(parsed).toMatchObject({
			agentId: "bot",
			rest: "main",
			isAcp: false,
			isSubagent: false,
		});
	});

	it("flags ACP and subagent keys", () => {
		expect(buildAcpSessionKey("bot", "s1")).toBe("agent:bot:acp:s1");
		expect(buildSubagentSessionKey("bot", "Sub1", "extra")).toBe(
			"agent:bot:subagent:sub1:extra",
		);
		expect(isAcpSessionKey("agent:bot:acp:s1")).toBe(true);
		expect(isAcpSessionKey("agent:bot:main")).toBe(false);
		expect(isSubagentSessionKey("agent:bot:subagent:s")).toBe(true);
	});

	it("parses a thread suffix into threadId + parentKey", () => {
		const parsed = parseAgentSessionKey("agent:bot:main:thread:t1");
		expect(parsed?.threadId).toBe("t1");
		expect(parsed?.parentKey).toBe("agent:bot:main");
		expect(resolveThreadParentSessionKey("agent:bot:main:thread:t1")).toBe(
			"agent:bot:main",
		);
		// a non-thread key resolves to itself.
		expect(resolveThreadParentSessionKey("agent:bot:main")).toBe(
			"agent:bot:main",
		);
	});

	it("rejects malformed keys", () => {
		expect(parseAgentSessionKey("nonsense")).toBeNull();
		expect(parseAgentSessionKey("agent:bot")).toBeNull(); // < 3 parts
		expect(parseAgentSessionKey("")).toBeNull();
		expect(parseAgentSessionKey(null)).toBeNull();
		expect(resolveThreadParentSessionKey("bad")).toBeNull();
	});
});

describe("normalization", () => {
	it("normalizeMainKey defaults empty to 'main', lowercases", () => {
		expect(normalizeMainKey("")).toBe("main");
		expect(normalizeMainKey("Foo")).toBe("foo");
	});

	it("normalizeAgentId keeps valid ids, collapses invalid chars, defaults empty", () => {
		expect(normalizeAgentId("MyBot")).toBe("mybot");
		expect(normalizeAgentId("")).toBe("main");
		expect(normalizeAgentId("a b!c")).toBe("a-b-c");
		expect(normalizeAgentId("!!!")).toBe("main"); // collapses to empty → default
		expect(sanitizeAgentId("MyBot")).toBe("mybot"); // alias
	});

	it("normalizeAccountId defaults empty to 'default'", () => {
		expect(normalizeAccountId("")).toBe("default");
		expect(normalizeAccountId("Acct1")).toBe("acct1");
	});
});
