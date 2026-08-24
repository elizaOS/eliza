/**
 * The sessions barrel (`src/sessions/index.ts`) is the public surface for
 * session identity keys, session entry contracts, and session context
 * providers. These tests drive the real modules through that barrel: key
 * build/parse/conversion round-trips, entry create/merge/validate semantics
 * against wall-clock behavior, and provider output for session state, skills
 * snapshots, and send policy. Deterministic harness — no mocks, no network.
 */
import { describe, expect, it } from "vitest";
import type { Memory, SessionSkillsSnapshot } from "../types/memory.ts";
import {
	buildAgentPeerSessionKey,
	buildGroupHistoryKey,
	buildSubagentSessionKey,
	createSendPolicyProvider,
	createSessionEntry,
	createSessionProvider,
	createSessionSkillsProvider,
	DEFAULT_ACCOUNT_ID,
	DEFAULT_AGENT_ID,
	DEFAULT_IDLE_MINUTES,
	DEFAULT_MAIN_KEY,
	DEFAULT_RESET_TRIGGER,
	DEFAULT_RESET_TRIGGERS,
	extractSessionContext,
	getSessionProviders,
	isAcpSessionKey,
	isSubagentSessionKey,
	isValidSessionEntry,
	mergeSessionEntry,
	parseAgentSessionKey,
	resolveAgentIdFromSessionKey,
	resolveThreadSessionKeys,
	type SessionEntry,
	toAgentRequestSessionKey,
	toAgentStoreSessionKey,
} from "./index.ts";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeMemory(overrides: Record<string, unknown> = {}): Memory {
	return {
		entityId: "00000000-0000-4000-8000-000000000001",
		roomId: "00000000-0000-4000-8000-000000000002",
		content: { text: "hello" },
		...overrides,
	} as Memory;
}

function entryWith(overrides: Partial<SessionEntry> = {}): SessionEntry {
	return { sessionId: "entry-1", updatedAt: 1_700_000_000_000, ...overrides };
}

type SessionProvider = ReturnType<typeof createSessionProvider>;
type ProviderGetResult = Awaited<ReturnType<SessionProvider["get"]>>;

async function getWithContext(
	provider: SessionProvider,
	message: Memory,
): Promise<ProviderGetResult> {
	return provider.get(
		{} as Parameters<SessionProvider["get"]>[0],
		message,
		{} as Parameters<SessionProvider["get"]>[2],
	);
}

describe("exported defaults", () => {
	it("exposes the documented default ids, reset triggers, and idle window", () => {
		expect(DEFAULT_AGENT_ID).toBe("main");
		expect(DEFAULT_MAIN_KEY).toBe("main");
		expect(DEFAULT_ACCOUNT_ID).toBe("default");
		expect(DEFAULT_RESET_TRIGGER).toBe("/new");
		expect(DEFAULT_RESET_TRIGGERS).toEqual(["/new", "/reset"]);
		expect(DEFAULT_IDLE_MINUTES).toBe(60);
	});
});

describe("session identity keys through the barrel", () => {
	it("round-trips subagent keys through parse", () => {
		const key = buildSubagentSessionKey("Bot", "Scout1", "research");
		expect(key).toBe("agent:bot:subagent:scout1:research");

		const parsed = parseAgentSessionKey(key);
		expect(parsed).toMatchObject({
			raw: key,
			agentId: "bot",
			rest: "subagent:scout1:research",
			isSubagent: true,
			isAcp: false,
		});
		expect(isSubagentSessionKey(key)).toBe(true);
		expect(isAcpSessionKey(key)).toBe(false);
	});

	it("scopes DM peer sessions per dmScope, falling back to the agent main key", () => {
		expect(
			buildAgentPeerSessionKey({ agentId: "Bot", channel: "discord" }),
		).toBe("agent:bot:main");
		expect(
			buildAgentPeerSessionKey({
				agentId: "Bot",
				channel: "discord",
				dmScope: "per-peer",
				peerId: "Alice",
			}),
		).toBe("agent:bot:dm:alice");
		expect(
			buildAgentPeerSessionKey({
				agentId: "Bot",
				channel: "Discord",
				dmScope: "per-channel-peer",
				peerId: "Alice",
			}),
		).toBe("agent:bot:discord:dm:alice");
		expect(
			buildAgentPeerSessionKey({
				agentId: "Bot",
				channel: "Discord",
				dmScope: "per-account-channel-peer",
				peerId: "Alice",
			}),
		).toBe("agent:bot:discord:default:dm:alice");
		expect(
			buildAgentPeerSessionKey({
				agentId: "Bot",
				channel: "Discord",
				accountId: "Acct1",
				dmScope: "per-account-channel-peer",
				peerId: "Alice",
			}),
		).toBe("agent:bot:discord:acct1:dm:alice");
	});

	it("keys non-DM peers by channel, kind, and peer id", () => {
		expect(
			buildAgentPeerSessionKey({
				agentId: "bot",
				channel: "Telegram",
				peerKind: "group",
				peerId: "Room1",
			}),
		).toBe("agent:bot:telegram:group:room1");
	});

	it("builds group history keys from channel, account, kind, and peer", () => {
		expect(
			buildGroupHistoryKey({
				channel: "Discord",
				accountId: null,
				peerKind: "group",
				peerId: "G1",
			}),
		).toBe("discord:default:group:g1");
	});

	it("strips the agent prefix for request keys and restores it for store keys", () => {
		expect(toAgentRequestSessionKey("agent:bot:main")).toBe("main");
		expect(toAgentRequestSessionKey("agent:bot:acp:s1")).toBe("acp:s1");
		expect(toAgentRequestSessionKey("not-a-key")).toBe("not-a-key");
		expect(toAgentRequestSessionKey(null)).toBeUndefined();

		expect(
			toAgentStoreSessionKey({ agentId: "Bot", requestKey: undefined }),
		).toBe("agent:bot:main");
		expect(
			toAgentStoreSessionKey({ agentId: "Bot", requestKey: "custom" }),
		).toBe("agent:bot:custom");
		expect(
			toAgentStoreSessionKey({ agentId: "Bot", requestKey: "subagent:s1" }),
		).toBe("agent:bot:subagent:s1");
		expect(
			toAgentStoreSessionKey({ agentId: "Other", requestKey: "AGENT:x:y" }),
		).toBe("agent:x:y");
	});

	it("resolves the owning agent and thread-scoped keys from session keys", () => {
		expect(resolveAgentIdFromSessionKey("agent:Carol:main")).toBe("carol");
		expect(resolveAgentIdFromSessionKey("garbage")).toBe("main");

		expect(
			resolveThreadSessionKeys({ baseSessionKey: "agent:bot:main" }),
		).toEqual({ sessionKey: "agent:bot:main", parentSessionKey: undefined });
		expect(
			resolveThreadSessionKeys({
				baseSessionKey: "agent:bot:main",
				threadId: "T1",
			}),
		).toEqual({
			sessionKey: "agent:bot:main:thread:t1",
			parentSessionKey: undefined,
		});
		expect(
			resolveThreadSessionKeys({
				baseSessionKey: "agent:bot:main",
				threadId: "T1",
				useSuffix: false,
				parentSessionKey: "agent:bot:main",
			}),
		).toEqual({
			sessionKey: "agent:bot:main",
			parentSessionKey: "agent:bot:main",
		});
	});
});

describe("session entry lifecycle", () => {
	it("creates entries with generated identity unless overridden", () => {
		const before = Date.now();
		const created = createSessionEntry();
		const after = Date.now();

		expect(created.sessionId).toMatch(UUID_RE);
		expect(created.updatedAt).toBeGreaterThanOrEqual(before);
		expect(created.updatedAt).toBeLessThanOrEqual(after);

		const labeled = createSessionEntry({
			sessionId: "fixed-id",
			label: "Work",
			chatType: "dm",
			updatedAt: 123,
		});
		expect(labeled).toMatchObject({
			sessionId: "fixed-id",
			label: "Work",
			chatType: "dm",
			updatedAt: 123,
		});
	});

	it("merges into a new entry, bumping stale timestamps to now but honoring future ones", () => {
		const before = Date.now();
		const merged = mergeSessionEntry(undefined, {
			chatType: "group",
			updatedAt: before - 10_000,
		});
		expect(merged.chatType).toBe("group");
		expect(merged.sessionId).toMatch(UUID_RE);
		expect(merged.updatedAt).toBeGreaterThanOrEqual(before);

		const future = Date.now() + 60_000;
		const scheduled = mergeSessionEntry(undefined, { updatedAt: future });
		expect(scheduled.updatedAt).toBe(future);
	});

	it("merges patches over existing entries without regenerating identity", () => {
		const existing = entryWith({
			label: "Old",
			channel: "discord",
			sendPolicy: "allow",
		});
		const merged = mergeSessionEntry(existing, { label: "New" });

		expect(merged.sessionId).toBe(existing.sessionId);
		expect(merged.label).toBe("New");
		expect(merged.channel).toBe("discord");
		expect(merged.sendPolicy).toBe("allow");

		const rekeyed = mergeSessionEntry(existing, { sessionId: "replacement" });
		expect(rekeyed.sessionId).toBe("replacement");
	});

	it("never lowers updatedAt below the newest of existing, patch, and now", () => {
		const now = Date.now();
		const existing = entryWith({ updatedAt: now });

		const loweredPatch = mergeSessionEntry(existing, {
			updatedAt: now - 10_000,
		});
		expect(loweredPatch.updatedAt).toBeGreaterThanOrEqual(now);

		const emptyPatch = mergeSessionEntry(entryWith({ updatedAt: now }), {});
		expect(emptyPatch.updatedAt).toBeGreaterThanOrEqual(now);
	});
});

describe("isValidSessionEntry", () => {
	it("accepts only entries with a non-empty string sessionId and numeric updatedAt", () => {
		expect(isValidSessionEntry(entryWith())).toBe(true);

		expect(isValidSessionEntry(null)).toBe(false);
		expect(isValidSessionEntry(undefined)).toBe(false);
		expect(isValidSessionEntry("entry")).toBe(false);
		expect(isValidSessionEntry(42)).toBe(false);
		expect(isValidSessionEntry([])).toBe(false);
		expect(isValidSessionEntry({ updatedAt: 1 })).toBe(false);
		expect(isValidSessionEntry({ sessionId: "", updatedAt: 1 })).toBe(false);
		expect(isValidSessionEntry({ sessionId: "s", updatedAt: "1" })).toBe(false);
	});
});

describe("extractSessionContext", () => {
	it("prefers direct memory properties over metadata", () => {
		const context = extractSessionContext(
			makeMemory({
				sessionId: "direct-id",
				sessionKey: "direct-key",
				metadata: { sessionId: "meta-id", sessionKey: "meta-key" },
			}),
		);
		expect(context).toEqual({
			sessionId: "direct-id",
			sessionKey: "direct-key",
			entry: undefined,
		});
	});

	it("falls back to metadata fields when direct ones are absent", () => {
		const context = extractSessionContext(
			makeMemory({
				metadata: { sessionId: "meta-id", sessionKey: "meta-key" },
			}),
		);
		expect(context?.sessionId).toBe("meta-id");
		expect(context?.sessionKey).toBe("meta-key");
		expect(context?.entry).toBeUndefined();

		const preferMeta = extractSessionContext(
			makeMemory({
				metadata: {
					sessionId: "meta-id",
					session: entryWith({ sessionId: "stored-id" }),
				},
			}),
		);
		expect(preferMeta?.sessionId).toBe("meta-id");
	});

	it("uses a stored session entry as the last sessionId source and returns it", () => {
		const stored = entryWith({ sessionId: "stored-id" });
		const context = extractSessionContext(
			makeMemory({ metadata: { session: stored } }),
		);
		expect(context?.sessionId).toBe("stored-id");
		expect(context?.sessionKey).toBeUndefined();
		expect(context?.entry).toBe(stored);
	});

	it("returns null when the memory carries no session information", () => {
		expect(extractSessionContext(makeMemory())).toBeNull();
	});
});

describe("session provider", () => {
	it("defaults its name and reports missing context as hasSession false", async () => {
		const provider = createSessionProvider();
		expect(provider.name).toBe("session");

		const result = await getWithContext(provider, makeMemory());
		expect(result.text).toBe("No session context available.");
		expect(result.data).toEqual({ hasSession: false });
		expect(result.values).toBeUndefined();
	});

	it("renders the full session entry into ordered context lines", async () => {
		const provider = createSessionProvider({ name: "custom-session" });
		expect(provider.name).toBe("custom-session");

		const entry = entryWith({
			label: "Work",
			chatType: "dm",
			channel: "discord",
			modelOverride: "model-x",
			thinkingLevel: "high",
			sendPolicy: "deny",
			totalTokens: 42,
		});
		const message = makeMemory({
			sessionId: "sid-1",
			sessionKey: "agent:bot:main",
			metadata: { session: entry },
		});

		const result = await getWithContext(provider, message);
		expect(result.text).toBe(
			[
				"Session ID: sid-1",
				"Session Key: agent:bot:main",
				"Label: Work",
				"Chat Type: dm",
				"Channel: discord",
				"Model Override: model-x",
				"Thinking Level: high",
				"",
				"⚠️ SEND POLICY: DENY - Do not send messages externally.",
				"Total Tokens Used: 42",
			].join("\n"),
		);
		expect(result.values).toEqual({
			sessionId: "sid-1",
			sessionKey: "agent:bot:main",
			hasSession: true,
		});
		expect(result.data?.hasSession).toBe(true);
		expect(result.data?.entry).toEqual(entry);
	});

	it("renders a minimal memory without optional lines", async () => {
		const result = await getWithContext(
			createSessionProvider(),
			makeMemory({ sessionId: "sid-2" }),
		);
		expect(result.text).toBe("Session ID: sid-2");
		expect(result.values).toEqual({
			sessionId: "sid-2",
			sessionKey: undefined,
			hasSession: true,
		});
	});
});

describe("session skills provider", () => {
	it("reports absent context and absent snapshots distinctly", async () => {
		const provider = createSessionSkillsProvider();
		expect(provider.name).toBe("sessionSkills");

		const none = await getWithContext(provider, makeMemory());
		expect(none.text).toBe("No session skills available.");
		expect(none.data).toEqual({ hasSkills: false });

		const empty = await getWithContext(
			provider,
			makeMemory({ sessionId: "sid-1" }),
		);
		expect(empty.text).toBe("No skills configured for this session.");
		expect(empty.data).toEqual({ hasSkills: false, skills: [] });
	});

	it("lists active skills with their prompt", async () => {
		const snapshot: SessionSkillsSnapshot = {
			prompt: "Use skills wisely.",
			skills: [{ name: "browser" }, { name: "sql" }],
		};
		const message = makeMemory({
			sessionId: "sid-1",
			metadata: { session: entryWith({ skillsSnapshot: snapshot }) },
		});

		const result = await getWithContext(createSessionSkillsProvider(), message);
		expect(result.text).toBe(
			"Active Skills: browser, sql\n\nUse skills wisely.",
		);
		expect(result.values).toEqual({
			skillCount: 2,
			skillNames: ["browser", "sql"],
		});
		expect(result.data?.skills).toEqual([{ name: "browser" }, { name: "sql" }]);
	});
});

describe("send policy provider", () => {
	it("treats memories without session context as allowed", async () => {
		const provider = createSendPolicyProvider();
		expect(provider.name).toBe("sendPolicy");

		const result = await getWithContext(provider, makeMemory());
		expect(result.text).toBe("");
		expect(result.data).toEqual({ sendPolicy: "allow" });
	});

	it("blocks external sending when the entry denies", async () => {
		const message = makeMemory({
			sessionId: "sid-1",
			metadata: { session: entryWith({ sendPolicy: "deny" }) },
		});
		const result = await getWithContext(createSendPolicyProvider(), message);
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

	it("allows sending by default and positions itself prominently", async () => {
		const message = makeMemory({
			sessionId: "sid-1",
			metadata: { session: entryWith({}) },
		});
		const result = await getWithContext(createSendPolicyProvider(), message);
		expect(result.text).toBe("");
		expect(result.values).toEqual({ sendPolicy: "allow", canSend: true });

		expect(createSendPolicyProvider().position).toBe(100);
	});
});

describe("default provider bundle", () => {
	it("returns the three session providers in order", () => {
		const providers = getSessionProviders({ storePath: "/tmp/sessions.json" });
		expect(providers.map((provider) => provider.name)).toEqual([
			"session",
			"sessionSkills",
			"sendPolicy",
		]);
		for (const provider of providers) {
			expect(typeof provider.get).toBe("function");
		}
	});
});
