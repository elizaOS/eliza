/**
 * Covers the session context providers as pure deterministic functions:
 * `extractSessionContext` precedence across direct properties, metadata
 * fields, and metadata session entries; and the text/values/data contracts
 * of `createSessionProvider`, `createSessionSkillsProvider`,
 * `createSendPolicyProvider`, and `getSessionProviders`.
 */
import { describe, expect, it } from "vitest";
import type { Memory, Provider, State } from "../types";
import {
	createSendPolicyProvider,
	createSessionProvider,
	createSessionSkillsProvider,
	extractSessionContext,
	getSessionProviders,
} from "./provider";
import type { SessionEntry } from "./types";

const ENTITY_ID = "00000000-0000-0000-0000-0000000000e1";
const ROOM_ID = "00000000-0000-0000-0000-000000000040";
const SESSION_ID = "00000000-0000-0000-0000-000000005e55";
const SESSION_KEY = "agent:agent-1:telegram:+15551234567";

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
	return {
		sessionId: SESSION_ID,
		updatedAt: 1_700_000_000_000,
		...overrides,
	};
}

function memory(fields: Record<string, unknown> = {}): Memory {
	return {
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text: "hello" },
		...fields,
	} as Memory;
}

async function run(provider: Provider, message: Memory) {
	return provider.get({} as never, message, {} as State);
}

describe("extractSessionContext", () => {
	it("returns sessionId and sessionKey from direct memory properties", () => {
		const context = extractSessionContext(
			memory({ sessionId: SESSION_ID, sessionKey: SESSION_KEY }),
		);
		expect(context).toEqual({
			sessionId: SESSION_ID,
			sessionKey: SESSION_KEY,
			entry: undefined,
		});
	});

	it("falls back to metadata sessionId and sessionKey", () => {
		const context = extractSessionContext(
			memory({ metadata: { sessionId: SESSION_ID, sessionKey: SESSION_KEY } }),
		);
		expect(context?.sessionId).toBe(SESSION_ID);
		expect(context?.sessionKey).toBe(SESSION_KEY);
		expect(context?.entry).toBeUndefined();
	});

	it("derives sessionId from a metadata.session entry and passes the entry through", () => {
		const session = entry({ label: "Support thread" });
		const context = extractSessionContext(memory({ metadata: { session } }));
		expect(context?.sessionId).toBe(SESSION_ID);
		expect(context?.sessionKey).toBeUndefined();
		expect(context?.entry).toBe(session);
	});

	it("prefers direct properties over metadata fields", () => {
		const context = extractSessionContext(
			memory({
				sessionId: SESSION_ID,
				metadata: {
					sessionId: "11111111-1111-1111-1111-111111111111",
					sessionKey: "agent:a:other:key",
				},
			}),
		);
		expect(context?.sessionId).toBe(SESSION_ID);
		expect(context?.sessionKey).toBe("agent:a:other:key");
	});

	it("prefers metadata.sessionId over the entry sessionId", () => {
		const context = extractSessionContext(
			memory({
				metadata: {
					sessionId: SESSION_ID,
					session: entry({
						sessionId: "22222222-2222-2222-2222-222222222222",
					}),
				},
			}),
		);
		expect(context?.sessionId).toBe(SESSION_ID);
	});

	it("does not read sessionKey from the metadata.session entry", () => {
		const session = entry({ sessionId: SESSION_ID });
		const context = extractSessionContext(
			memory({ metadata: { session, sessionKey: SESSION_KEY } }),
		);
		expect(context?.sessionKey).toBe(SESSION_KEY);
	});

	it("does not take sessionKey from the entry when only metadata.session is present", () => {
		const session = entry({
			sessionId: SESSION_ID,
			lastChannel: "telegram",
		});
		const context = extractSessionContext(memory({ metadata: { session } }));
		expect(context).not.toBeNull();
		expect(context?.sessionKey).toBeUndefined();
	});

	it("returns null when no session information is present", () => {
		expect(extractSessionContext(memory())).toBeNull();
		expect(extractSessionContext(memory({ metadata: {} }))).toBeNull();
	});
});

describe("createSessionProvider", () => {
	it("exposes stable provider metadata", () => {
		const provider = createSessionProvider();
		expect(provider.name).toBe("session");
		expect(provider.description).toBe("Current session context and state");
		expect(provider.dynamic).toBe(true);
		expect(provider.contexts).toEqual(["general", "messaging"]);
		expect(provider.contextGate).toEqual({ anyOf: ["general", "messaging"] });
		expect(provider.cacheStable).toBe(false);
		expect(provider.cacheScope).toBe("turn");
		expect(provider.roleGate).toEqual({ minRole: "USER" });
	});

	it("honors a custom name", () => {
		expect(createSessionProvider({ name: "custom-session" }).name).toBe(
			"custom-session",
		);
	});

	it("reports an unavailable session without session context", async () => {
		const result = await run(createSessionProvider(), memory());
		expect(result.text).toBe("No session context available.");
		expect(result.data).toEqual({ hasSession: false });
	});

	it("renders an unknown id placeholder when only a session key is present", async () => {
		const result = await run(
			createSessionProvider(),
			memory({ sessionKey: SESSION_KEY }),
		);
		expect(result.text).toBe(
			`Session ID: unknown\nSession Key: ${SESSION_KEY}`,
		);
	});

	it("renders sparse entries with only the populated optional lines", async () => {
		const result = await run(
			createSessionProvider(),
			memory({
				sessionId: SESSION_ID,
				metadata: {
					session: entry({ totalTokens: 4321 }),
				},
			}),
		);
		expect(result.text).toBe(
			`Session ID: ${SESSION_ID}\nTotal Tokens Used: 4321`,
		);
	});

	it("renders full entry details in field order", async () => {
		const result = await run(
			createSessionProvider(),
			memory({
				sessionId: SESSION_ID,
				sessionKey: SESSION_KEY,
				metadata: {
					session: entry({
						label: "Ops channel",
						chatType: "channel",
						channel: "discord",
						modelOverride: "gpt-5.6-sol",
						thinkingLevel: "high",
						totalTokens: 9001,
					}),
				},
			}),
		);
		expect(result.text).toBe(
			[
				`Session ID: ${SESSION_ID}`,
				`Session Key: ${SESSION_KEY}`,
				"Label: Ops channel",
				"Chat Type: channel",
				"Channel: discord",
				"Model Override: gpt-5.6-sol",
				"Thinking Level: high",
				"Total Tokens Used: 9001",
			].join("\n"),
		);
	});

	it("appends the send-policy denial warning for deny entries", async () => {
		const result = await run(
			createSessionProvider(),
			memory({
				sessionId: SESSION_ID,
				metadata: { session: entry({ sendPolicy: "deny" }) },
			}),
		);
		expect(result.text).toBe(
			[
				`Session ID: ${SESSION_ID}`,
				"",
				"⚠️ SEND POLICY: DENY - Do not send messages externally.",
			].join("\n"),
		);
	});

	it("carries structured values and data for an active session", async () => {
		const session = entry({ label: "Pinned" });
		const result = await run(
			createSessionProvider(),
			memory({
				sessionId: SESSION_ID,
				sessionKey: SESSION_KEY,
				metadata: { session },
			}),
		);
		expect(result.values).toEqual({
			sessionId: SESSION_ID,
			sessionKey: SESSION_KEY,
			hasSession: true,
		});
		expect(result.data).toMatchObject({
			hasSession: true,
			sessionId: SESSION_ID,
			sessionKey: SESSION_KEY,
		});
		expect(result.data?.entry).toBe(session);
	});
});

describe("createSessionSkillsProvider", () => {
	it("honors a custom name over the default", () => {
		const provider = createSessionSkillsProvider({ name: "skills-now" });
		expect(provider.name).toBe("skills-now");
		expect(createSessionSkillsProvider().name).toBe("sessionSkills");
	});

	it("reports unavailable skills without session context", async () => {
		const result = await run(createSessionSkillsProvider(), memory());
		expect(result.text).toBe("No session skills available.");
		expect(result.data).toEqual({ hasSkills: false });
	});

	it("reports no configured skills for an entry without a snapshot", async () => {
		const result = await run(
			createSessionSkillsProvider(),
			memory({
				sessionId: SESSION_ID,
				metadata: { session: entry() },
			}),
		);
		expect(result.text).toBe("No skills configured for this session.");
		expect(result.data).toEqual({ hasSkills: false, skills: [] });
	});

	it("reports no configured skills for an empty snapshot skill list", async () => {
		const result = await run(
			createSessionSkillsProvider(),
			memory({
				sessionId: SESSION_ID,
				metadata: {
					session: entry({
						skillsSnapshot: { prompt: "unused prompt", skills: [] },
					}),
				},
			}),
		);
		expect(result.text).toBe("No skills configured for this session.");
		expect(result.data).toEqual({ hasSkills: false, skills: [] });
	});

	it("lists active skill names with the snapshot prompt", async () => {
		const skills = [{ name: "weather" }, { name: "calendar" }];
		const result = await run(
			createSessionSkillsProvider(),
			memory({
				sessionId: SESSION_ID,
				metadata: {
					session: entry({
						skillsSnapshot: { prompt: "Use these skills.", skills },
					}),
				},
			}),
		);
		expect(result.text).toBe(
			"Active Skills: weather, calendar\n\nUse these skills.",
		);
		expect(result.values).toEqual({
			skillCount: 2,
			skillNames: ["weather", "calendar"],
		});
		expect(result.data).toEqual({
			hasSkills: true,
			skills,
			prompt: "Use these skills.",
		});
	});
});

describe("createSendPolicyProvider", () => {
	it("is positioned prominently with its default name", () => {
		const provider = createSendPolicyProvider();
		expect(provider.name).toBe("sendPolicy");
		expect(provider.position).toBe(100);
		expect(createSendPolicyProvider({ name: "policy" }).name).toBe("policy");
	});

	it("allows sending when there is no session context", async () => {
		const result = await run(createSendPolicyProvider(), memory());
		expect(result.text).toBe("");
		expect(result.values).toBeUndefined();
		expect(result.data).toEqual({ sendPolicy: "allow" });
	});

	it("defaults to allow for entries without an explicit policy", async () => {
		const result = await run(
			createSendPolicyProvider(),
			memory({
				sessionId: SESSION_ID,
				metadata: { session: entry() },
			}),
		);
		expect(result.values).toEqual({ sendPolicy: "allow", canSend: true });
		expect(result.data).toEqual({ sendPolicy: "allow", canSend: true });
	});

	it("blocks external sending with the denial block for deny entries", async () => {
		const result = await run(
			createSendPolicyProvider(),
			memory({
				sessionId: SESSION_ID,
				metadata: { session: entry({ sendPolicy: "deny" }) },
			}),
		);
		expect(result.text).toBe(
			[
				"🚫 SEND POLICY: DENY",
				"",
				"This session has sending DISABLED.",
				"Do NOT send messages to external channels.",
				"Do NOT use send/reply actions.",
				"You may still process and respond internally.",
			].join("\n"),
		);
		expect(result.values).toEqual({ sendPolicy: "deny", canSend: false });
		expect(result.data).toEqual({ sendPolicy: "deny", canSend: false });
	});
});

describe("getSessionProviders", () => {
	it("returns the three session providers in order", () => {
		const providers = getSessionProviders();
		expect(providers.map((p) => p.name)).toEqual([
			"session",
			"sessionSkills",
			"sendPolicy",
		]);
	});
});
