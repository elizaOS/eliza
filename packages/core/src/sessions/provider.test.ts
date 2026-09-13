/**
 * Behavioral pins for the session context providers registered into every
 * runtime turn (eliza-plugin.ts spreads getSessionProviders() into its
 * providers). The send-policy provider emits the model-facing instruction
 * that a deny session must not send external messages, so the deny/allow
 * branch pair, the extraction precedence, and the rendered session lines are
 * asserted on real Memory inputs — not on provider metadata.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../types/memory.js";
import type { IAgentRuntime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import {
	createSendPolicyProvider,
	createSessionProvider,
	createSessionSkillsProvider,
	extractSessionContext,
	getSessionProviders,
} from "./provider.ts";
import type { SessionEntry } from "./types.js";

const runtime = {} as IAgentRuntime;
const state = {} as State;

function memory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as Memory["id"],
		agentId: "00000000-0000-0000-0000-000000000002" as Memory["agentId"],
		roomId: "00000000-0000-0000-0000-000000000003" as Memory["roomId"],
		content: { text: "hello" },
		...overrides,
	} as Memory;
}

function sessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
	return {
		sessionId: "sess-entry-1",
		label: "Pairing session",
		chatType: "dm",
		channel: "telegram",
		modelOverride: "glm-5.3",
		thinkingLevel: "high",
		sendPolicy: "allow",
		totalTokens: 1234,
		...overrides,
	} as SessionEntry;
}

describe("extractSessionContext", () => {
	it("prefers direct memory fields over metadata and the nested session entry", () => {
		const context = extractSessionContext(
			memory({
				sessionId: "direct-id",
				sessionKey: "agent:bot:main",
				metadata: {
					sessionId: "meta-id",
					session: sessionEntry({ sessionId: "entry-id" }),
				} as Memory["metadata"],
			}),
		);
		expect(context).not.toBeNull();
		expect(context?.sessionId).toBe("direct-id");
		expect(context?.sessionKey).toBe("agent:bot:main");
		expect(context?.entry?.sessionId).toBe("entry-id");
	});

	it("falls back to metadata.sessionId, then the nested session entry's id", () => {
		const fromMetadata = extractSessionContext(
			memory({
				metadata: { sessionId: "meta-id" } as Memory["metadata"],
			}),
		);
		expect(fromMetadata?.sessionId).toBe("meta-id");

		const fromEntry = extractSessionContext(
			memory({
				metadata: {
					session: sessionEntry({ sessionId: "entry-id" }),
				} as Memory["metadata"],
			}),
		);
		expect(fromEntry?.sessionId).toBe("entry-id");
		expect(fromEntry?.entry?.label).toBe("Pairing session");
	});

	it("resolves conflicting values at both precedence boundaries", () => {
		// No direct field: metadata.sessionId must beat the nested entry's id.
		const metadataVsEntry = extractSessionContext(
			memory({
				metadata: {
					sessionId: "meta-id",
					session: sessionEntry({ sessionId: "entry-id" }),
				} as Memory["metadata"],
			}),
		);
		expect(metadataVsEntry?.sessionId).toBe("meta-id");
		expect(metadataVsEntry?.entry?.sessionId).toBe("entry-id");

		// Direct sessionKey must beat metadata.sessionKey when both exist.
		const keyConflict = extractSessionContext(
			memory({
				sessionId: "sess-x",
				sessionKey: "agent:bot:direct",
				metadata: { sessionKey: "agent:bot:meta" } as Memory["metadata"],
			}),
		);
		expect(keyConflict?.sessionKey).toBe("agent:bot:direct");
	});

	it("resolves sessionKey from memory, then metadata, and returns null when neither id nor key resolves", () => {
		const fromMemory = extractSessionContext(
			memory({ sessionKey: "agent:bot:main" }),
		);
		expect(fromMemory).toEqual({
			sessionId: undefined,
			sessionKey: "agent:bot:main",
			entry: undefined,
		});

		const fromMetadata = extractSessionContext(
			memory({
				metadata: { sessionKey: "agent:bot:alt" } as Memory["metadata"],
			}),
		);
		expect(fromMetadata?.sessionKey).toBe("agent:bot:alt");

		expect(extractSessionContext(memory())).toBeNull();
	});

	it("falls back to metadata when direct fields are empty strings, preserving the deny entry", () => {
		// Regression: connectors may default an unset sessionId/sessionKey to
		// "" (not undefined). The empty string previously won the ?? chain,
		// erased the metadata session carrying an explicit sendPolicy deny,
		// and flipped createSendPolicyProvider to its default-allow result.
		const shadowed = extractSessionContext(
			memory({
				sessionId: "",
				sessionKey: "",
				metadata: {
					sessionId: "meta-id",
					sessionKey: "agent:bot:main",
					session: sessionEntry({ sendPolicy: "deny" }),
				} as Memory["metadata"],
			}),
		);
		expect(shadowed).toEqual({
			sessionId: "meta-id",
			sessionKey: "agent:bot:main",
			entry: sessionEntry({ sendPolicy: "deny" }),
		});

		// Direct fields that are present and non-empty still win.
		const present = extractSessionContext(
			memory({
				sessionId: "direct-id",
				metadata: { sessionId: "meta-id" } as Memory["metadata"],
			}),
		);
		expect(present?.sessionId).toBe("direct-id");
	});

	it("keeps the deny policy enforced when direct fields are empty strings", async () => {
		// Regression for the provider-level consequence of the same bug:
		// the sendPolicy provider must surface the metadata session's deny,
		// not silently default to allow when direct fields are "".
		const provider = createSendPolicyProvider();
		const result = await provider.get(
			runtime,
			memory({
				sessionId: "",
				sessionKey: "",
				metadata: {
					session: sessionEntry({ sendPolicy: "deny" }),
				} as Memory["metadata"],
			}),
			state,
		);
		expect(result.text).toContain("SEND POLICY: DENY");
		expect(result.values).toEqual({ sendPolicy: "deny", canSend: false });
	});
});

describe("createSessionProvider", () => {
	it("renders every populated entry field and the deny warning for a deny session", async () => {
		const provider = createSessionProvider();

		const deny = await provider.get(
			runtime,
			memory({
				sessionId: "sess-1",
				sessionKey: "agent:bot:main",
				metadata: {
					session: sessionEntry({ sendPolicy: "deny" }),
				} as Memory["metadata"],
			}),
			state,
		);
		// Semantic pins: each supplied field reaches the model-facing text,
		// and the deny policy is called out explicitly.
		expect(deny.text).toContain("Session ID: sess-1");
		expect(deny.text).toContain("Session Key: agent:bot:main");
		expect(deny.text).toContain("Pairing session");
		expect(deny.text).toContain("Chat Type: dm");
		expect(deny.text).toContain("telegram");
		expect(deny.text).toContain("glm-5.3");
		expect(deny.text).toContain("Thinking Level: high");
		expect(deny.text).toContain("SEND POLICY: DENY");
		expect(deny.text).toContain("Total Tokens Used: 1234");
		expect(deny.values).toEqual({
			sessionId: "sess-1",
			sessionKey: "agent:bot:main",
			hasSession: true,
		});
		expect(deny.data).toMatchObject({ hasSession: true, sessionId: "sess-1" });
	});

	it("omits absent entry fields and the deny line for an allow session", async () => {
		const provider = createSessionProvider();
		const result = await provider.get(
			runtime,
			memory({
				sessionId: "sess-2",
				metadata: {
					session: sessionEntry({
						label: undefined,
						chatType: undefined,
						channel: undefined,
						modelOverride: undefined,
						thinkingLevel: undefined,
						totalTokens: undefined,
						sendPolicy: "allow",
					}),
				} as Memory["metadata"],
			}),
			state,
		);
		expect(result.text).toContain("Session ID: sess-2");
		expect(result.text).not.toContain("Label:");
		expect(result.text).not.toContain("Channel:");
		expect(result.text).not.toContain("SEND POLICY");
		expect(result.text).not.toContain("Total Tokens");
		expect(result.data).toMatchObject({
			hasSession: true,
			sessionId: "sess-2",
		});
	});

	it("reports no session context without inventing one", async () => {
		const provider = createSessionProvider();
		const result = await provider.get(runtime, memory(), state);
		expect(result.text).toBe("No session context available.");
		expect(result.data).toEqual({ hasSession: false });
	});
});

describe("createSendPolicyProvider", () => {
	it("renders the deny guidance with canSend false for a deny entry", async () => {
		const provider = createSendPolicyProvider();
		const result = await provider.get(
			runtime,
			memory({
				metadata: {
					session: sessionEntry({ sendPolicy: "deny" }),
				} as Memory["metadata"],
			}),
			state,
		);
		expect(result.text).toContain("SEND POLICY: DENY");
		expect(result.text).toContain("This session has sending DISABLED.");
		expect(result.text).toContain("Do NOT send messages to external channels.");
		expect(result.text).toContain(
			"You may still process and respond internally.",
		);
		expect(result.values).toEqual({ sendPolicy: "deny", canSend: false });
		expect(result.data).toEqual({ sendPolicy: "deny", canSend: false });
	});

	it("stays silent with canSend true for an explicit allow entry and an entry-less session", async () => {
		const provider = createSendPolicyProvider();

		const allow = await provider.get(
			runtime,
			memory({
				metadata: {
					session: sessionEntry({ sendPolicy: "allow" }),
				} as Memory["metadata"],
			}),
			state,
		);
		expect(allow.text).toBe("");
		expect(allow.values).toEqual({ sendPolicy: "allow", canSend: true });
		expect(allow.data).toEqual({ sendPolicy: "allow", canSend: true });

		const absent = await provider.get(
			runtime,
			memory({ sessionId: "sess-3" }),
			state,
		);
		expect(absent.text).toBe("");
		expect(absent.values).toEqual({ sendPolicy: "allow", canSend: true });
	});

	it("defaults a session-less message to allow with no canSend claim", async () => {
		const provider = createSendPolicyProvider();
		const noSession = await provider.get(runtime, memory(), state);
		expect(noSession.text).toBe("");
		expect(noSession.data).toEqual({ sendPolicy: "allow" });
		expect(noSession.data).not.toHaveProperty("canSend");
	});
});

describe("createSessionSkillsProvider", () => {
	it("distinguishes no-session, empty-snapshot, and active-snapshot messages", async () => {
		const provider = createSessionSkillsProvider();

		const noSession = await provider.get(runtime, memory(), state);
		expect(noSession.text).toBe("No session skills available.");
		expect(noSession.data).toEqual({ hasSkills: false });

		const empty = await provider.get(
			runtime,
			memory({
				metadata: {
					session: sessionEntry({
						skillsSnapshot: { prompt: "p", skills: [] },
					}),
				} as Memory["metadata"],
			}),
			state,
		);
		expect(empty.text).toBe("No skills configured for this session.");
		expect(empty.data).toEqual({ hasSkills: false, skills: [] });

		const active = await provider.get(
			runtime,
			memory({
				metadata: {
					session: sessionEntry({
						skillsSnapshot: {
							prompt: "Use skills carefully.",
							skills: [
								{ name: "calendar" },
								{ name: "email", primaryEnv: "IMAP_HOST" },
							],
						},
					}),
				} as Memory["metadata"],
			}),
			state,
		);
		expect(active.text).toContain("Active Skills:");
		expect(active.text).toContain("calendar");
		expect(active.text).toContain("email");
		expect(active.text).toContain("Use skills carefully.");
		expect(active.values).toEqual({
			skillCount: 2,
			skillNames: ["calendar", "email"],
		});
		expect(active.data).toEqual({
			hasSkills: true,
			skills: [
				{ name: "calendar" },
				{ name: "email", primaryEnv: "IMAP_HOST" },
			],
			prompt: "Use skills carefully.",
		});
	});
});

describe("getSessionProviders", () => {
	it("returns session, skills, and send-policy providers whose get() behavior is intact", async () => {
		const providers = getSessionProviders();
		expect(providers.map((p) => p.name)).toEqual([
			"session",
			"sessionSkills",
			"sendPolicy",
		]);

		const [session, skills, sendPolicy] = providers;

		const denyMemory = memory({
			sessionId: "agg-1",
			metadata: {
				session: sessionEntry({
					sendPolicy: "deny",
					skillsSnapshot: {
						prompt: "agg prompt",
						skills: [{ name: "calendar" }],
					},
				}),
			} as Memory["metadata"],
		});

		const sessionResult = await session.get(runtime, denyMemory, state);
		expect(sessionResult.text).toContain("Session ID: agg-1");
		expect(sessionResult.text).toContain("SEND POLICY: DENY");
		expect(sessionResult.data).toMatchObject({ hasSession: true });

		const skillsResult = await skills.get(runtime, denyMemory, state);
		expect(skillsResult.values).toEqual({
			skillCount: 1,
			skillNames: ["calendar"],
		});

		const policyResult = await sendPolicy.get(runtime, denyMemory, state);
		expect(policyResult.values).toEqual({ sendPolicy: "deny", canSend: false });
	});
});
