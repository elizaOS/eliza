/**
 * Tests for session management utilities.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Memory } from "../types/memory.js";
import type { IAgentRuntime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import {
	// Session keys
	buildAgentMainSessionKey,
	buildAgentSessionKey,
	clearSessionStoreCacheForTest,
	createSendPolicyProvider,
	// Types
	createSessionEntry,
	createSessionProvider,
	createSessionSkillsProvider,
	deleteSessionEntry,
	// Providers
	extractSessionContext,
	getSessionEntry,
	getSessionProviders,
	isValidSessionEntry,
	listSessionKeys,
	// Store
	loadSessionStore,
	mergeSessionEntry,
	normalizeAgentId,
	parseAgentSessionKey,
	resolveAgentSessionsDir,
	resolveSessionTranscriptPath,
	// Paths
	resolveStateDir,
	resolveStorePath,
	type SessionEntry,
	SessionStateManager,
	saveSessionStore,
	updateSessionStore,
	updateSessionStoreEntry,
	upsertSessionEntry,
} from "./index.js";

describe("session types", () => {
	describe("createSessionEntry", () => {
		it("creates entry with default values", () => {
			const entry = createSessionEntry();
			expect(entry.sessionId).toBeDefined();
			expect(entry.sessionId.length).toBeGreaterThan(0);
			expect(entry.updatedAt).toBeLessThanOrEqual(Date.now());
		});

		it("accepts overrides", () => {
			const entry = createSessionEntry({
				label: "Test Session",
				channel: "telegram",
			});
			expect(entry.label).toBe("Test Session");
			expect(entry.channel).toBe("telegram");
		});
	});

	describe("mergeSessionEntry", () => {
		it("creates new entry when existing is undefined", () => {
			const result = mergeSessionEntry(undefined, { label: "New" });
			expect(result.sessionId).toBeDefined();
			expect(result.label).toBe("New");
		});

		it("merges with existing entry", () => {
			const existing: SessionEntry = {
				sessionId: "test-123",
				updatedAt: 1000,
				label: "Old",
				channel: "discord",
			};
			const result = mergeSessionEntry(existing, { label: "Updated" });
			expect(result.sessionId).toBe("test-123");
			expect(result.label).toBe("Updated");
			expect(result.channel).toBe("discord");
			expect(result.updatedAt).toBeGreaterThan(1000);
		});

		it("preserves sessionId from patch if provided", () => {
			const existing: SessionEntry = {
				sessionId: "old-id",
				updatedAt: 1000,
			};
			const result = mergeSessionEntry(existing, { sessionId: "new-id" });
			expect(result.sessionId).toBe("new-id");
		});
	});

	describe("isValidSessionEntry", () => {
		it("returns true for valid entries", () => {
			expect(isValidSessionEntry({ sessionId: "abc", updatedAt: 123 })).toBe(
				true,
			);
		});

		it("returns false for null/undefined", () => {
			expect(isValidSessionEntry(null)).toBe(false);
			expect(isValidSessionEntry(undefined)).toBe(false);
		});

		it("returns false for missing sessionId", () => {
			expect(isValidSessionEntry({ updatedAt: 123 })).toBe(false);
		});

		it("returns false for empty sessionId", () => {
			expect(isValidSessionEntry({ sessionId: "", updatedAt: 123 })).toBe(
				false,
			);
		});

		it("returns false for non-numeric updatedAt", () => {
			expect(
				isValidSessionEntry({ sessionId: "abc", updatedAt: "invalid" }),
			).toBe(false);
		});
	});
});

describe("session store", () => {
	let tempDir: string;
	let storePath: string;

	beforeEach(async () => {
		clearSessionStoreCacheForTest();
		tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), "eliza-session-test-"),
		);
		storePath = path.join(tempDir, "sessions.json");
	});

	afterEach(async () => {
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	});

	describe("loadSessionStore", () => {
		it("returns empty object for missing file", () => {
			const store = loadSessionStore(storePath);
			expect(store).toEqual({});
		});

		it("loads existing store", async () => {
			const data = {
				"agent:main:main": {
					sessionId: "test-123",
					updatedAt: Date.now(),
				},
			};
			await fs.promises.writeFile(storePath, JSON.stringify(data), "utf-8");

			const store = loadSessionStore(storePath);
			expect(store["agent:main:main"]?.sessionId).toBe("test-123");
		});

		it("handles invalid JSON gracefully", async () => {
			await fs.promises.writeFile(storePath, "not valid json", "utf-8");
			const store = loadSessionStore(storePath);
			expect(store).toEqual({});
		});
	});

	describe("saveSessionStore", () => {
		it("creates parent directories", async () => {
			const deepPath = path.join(tempDir, "deep", "nested", "sessions.json");
			await saveSessionStore(deepPath, {
				key: { sessionId: "a", updatedAt: 1 },
			});

			const exists = fs.existsSync(deepPath);
			expect(exists).toBe(true);
		});

		it("saves and loads correctly", async () => {
			const store = {
				"agent:main:main": createSessionEntry({ label: "Main" }),
			};
			await saveSessionStore(storePath, store);

			const loaded = loadSessionStore(storePath, { skipCache: true });
			expect(loaded["agent:main:main"]?.label).toBe("Main");
		});
	});

	describe("updateSessionStore", () => {
		it("creates new store if none exists", async () => {
			await updateSessionStore(storePath, (store) => {
				store["agent:main:main"] = createSessionEntry({ label: "New" });
			});

			const loaded = loadSessionStore(storePath, { skipCache: true });
			expect(loaded["agent:main:main"]?.label).toBe("New");
		});

		it("mutates existing store", async () => {
			await fs.promises.writeFile(
				storePath,
				JSON.stringify({
					"agent:main:main": { sessionId: "orig", updatedAt: 1 },
				}),
				"utf-8",
			);

			await updateSessionStore(storePath, (store) => {
				const entry = store["agent:main:main"];
				if (entry) {
					entry.label = "Updated";
				}
			});

			const loaded = loadSessionStore(storePath, { skipCache: true });
			expect(loaded["agent:main:main"]?.label).toBe("Updated");
			expect(loaded["agent:main:main"]?.sessionId).toBe("orig");
		});
	});

	describe("upsertSessionEntry", () => {
		it("creates new entry if not exists", async () => {
			const result = await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:test",
				patch: { label: "Test" },
			});

			expect(result.sessionId).toBeDefined();
			expect(result.label).toBe("Test");
		});

		it("updates existing entry", async () => {
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:test",
				patch: { label: "First" },
			});

			const result = await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:test",
				patch: { label: "Second" },
			});

			expect(result.label).toBe("Second");
		});
	});

	describe("deleteSessionEntry", () => {
		it("deletes existing entry", async () => {
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:test",
				patch: { label: "ToDelete" },
			});

			const deleted = await deleteSessionEntry({
				storePath,
				sessionKey: "agent:main:test",
			});

			expect(deleted).toBe(true);
			expect(getSessionEntry(storePath, "agent:main:test")).toBeUndefined();
		});

		it("returns false for non-existent entry", async () => {
			const deleted = await deleteSessionEntry({
				storePath,
				sessionKey: "agent:main:nonexistent",
			});
			expect(deleted).toBe(false);
		});
	});

	describe("listSessionKeys", () => {
		it("returns empty array for empty store", () => {
			const keys = listSessionKeys(storePath);
			expect(keys).toEqual([]);
		});

		it("returns all keys", async () => {
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:one",
				patch: {},
			});
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:two",
				patch: {},
			});

			const keys = listSessionKeys(storePath);
			expect(keys).toContain("agent:main:one");
			expect(keys).toContain("agent:main:two");
		});
	});
});

describe("session paths", () => {
	describe("resolveStateDir", () => {
		it("uses ELIZA_STATE_DIR when set", () => {
			const dir = resolveStateDir(
				{ ELIZA_STATE_DIR: "/custom/state" },
				() => "/home/test",
			);
			expect(dir).toBe("/custom/state");
		});

		it("expands ~ in ELIZA_STATE_DIR", () => {
			const dir = resolveStateDir(
				{ ELIZA_STATE_DIR: "~/eliza-state" },
				() => "/home/test",
			);
			expect(dir).toBe("/home/test/eliza-state");
		});

		it("defaults to ~/.eliza", () => {
			const dir = resolveStateDir({}, () => "/home/test");
			expect(dir).toBe("/home/test/.eliza");
		});
	});

	describe("resolveAgentSessionsDir", () => {
		it("includes agent ID in path", () => {
			const dir = resolveAgentSessionsDir(
				"myagent",
				{ ELIZA_STATE_DIR: "/state" },
				() => "/home",
			);
			expect(dir).toBe("/state/agents/myagent/sessions");
		});

		it("defaults to main agent", () => {
			const dir = resolveAgentSessionsDir(
				undefined,
				{ ELIZA_STATE_DIR: "/state" },
				() => "/home",
			);
			expect(dir).toBe("/state/agents/main/sessions");
		});
	});

	describe("resolveSessionTranscriptPath", () => {
		it("creates basic path", () => {
			const prev = process.env.ELIZA_STATE_DIR;
			process.env.ELIZA_STATE_DIR = "/state";
			try {
				const filePath = resolveSessionTranscriptPath("sess-123", "main");
				expect(filePath).toBe("/state/agents/main/sessions/sess-123.jsonl");
			} finally {
				if (prev === undefined) {
					delete process.env.ELIZA_STATE_DIR;
				} else {
					process.env.ELIZA_STATE_DIR = prev;
				}
			}
		});

		it("includes topic ID when provided", () => {
			const prev = process.env.ELIZA_STATE_DIR;
			process.env.ELIZA_STATE_DIR = "/state";
			try {
				const filePath = resolveSessionTranscriptPath("sess-123", "main", 456);
				expect(filePath).toBe(
					"/state/agents/main/sessions/sess-123-topic-456.jsonl",
				);
			} finally {
				if (prev === undefined) {
					delete process.env.ELIZA_STATE_DIR;
				} else {
					process.env.ELIZA_STATE_DIR = prev;
				}
			}
		});
	});

	describe("resolveStorePath", () => {
		it("expands {agentId} placeholder", () => {
			const result = resolveStorePath("/data/{agentId}/store.json", {
				agentId: "test",
			});
			expect(result).toContain("/data/test/store.json");
		});

		it("uses default agent ID", () => {
			const result = resolveStorePath("/data/{agentId}/store.json");
			expect(result).toContain("/data/main/store.json");
		});
	});
});

describe("session keys", () => {
	describe("buildAgentMainSessionKey", () => {
		it("builds main session key", () => {
			const key = buildAgentMainSessionKey({ agentId: "myagent" });
			expect(key).toBe("agent:myagent:main");
		});

		it("uses custom main key", () => {
			const key = buildAgentMainSessionKey({
				agentId: "myagent",
				mainKey: "primary",
			});
			expect(key).toBe("agent:myagent:primary");
		});
	});

	describe("buildAgentSessionKey", () => {
		it("builds session key from parts", () => {
			const key = buildAgentSessionKey("myagent", "telegram:+1234567890");
			expect(key).toBe("agent:myagent:telegram:+1234567890");
		});

		it("normalizes to lowercase", () => {
			const key = buildAgentSessionKey("MyAgent", "Telegram:+1234567890");
			expect(key).toBe("agent:myagent:telegram:+1234567890");
		});
	});

	describe("parseAgentSessionKey", () => {
		it("parses valid session key", () => {
			const parsed = parseAgentSessionKey("agent:myagent:telegram:chat");
			expect(parsed).not.toBeNull();
			expect(parsed?.agentId).toBe("myagent");
			expect(parsed?.rest).toBe("telegram:chat");
		});

		it("returns null for invalid format", () => {
			expect(parseAgentSessionKey("invalid")).toBeNull();
			expect(parseAgentSessionKey("agent:")).toBeNull();
			expect(parseAgentSessionKey("")).toBeNull();
			expect(parseAgentSessionKey(null)).toBeNull();
		});

		it("identifies ACP sessions", () => {
			const parsed = parseAgentSessionKey("agent:main:acp:something");
			expect(parsed?.isAcp).toBe(true);
		});

		it("identifies subagent sessions", () => {
			const parsed = parseAgentSessionKey("agent:main:subagent:child:rest");
			expect(parsed?.isSubagent).toBe(true);
		});
	});

	describe("normalizeAgentId", () => {
		it("normalizes to lowercase", () => {
			expect(normalizeAgentId("MyAgent")).toBe("myagent");
		});

		it("defaults to main for empty", () => {
			expect(normalizeAgentId("")).toBe("main");
			expect(normalizeAgentId(null)).toBe("main");
			expect(normalizeAgentId(undefined)).toBe("main");
		});

		it("replaces invalid characters", () => {
			expect(normalizeAgentId("my agent!")).toBe("my-agent");
		});
	});
});

describe("edge cases", () => {
	let tempDir: string;
	let storePath: string;

	beforeEach(async () => {
		clearSessionStoreCacheForTest();
		tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), "eliza-session-edge-"),
		);
		storePath = path.join(tempDir, "sessions.json");
	});

	afterEach(async () => {
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	});

	describe("concurrent updates", () => {
		it("handles concurrent upserts without data loss", async () => {
			// Start multiple concurrent upserts
			const promises = Array.from({ length: 5 }, (_, i) =>
				upsertSessionEntry({
					storePath,
					sessionKey: `agent:main:test-${i}`,
					patch: { label: `Session ${i}` },
				}),
			);

			await Promise.all(promises);

			const keys = listSessionKeys(storePath);
			expect(keys.length).toBe(5);
			for (let i = 0; i < 5; i++) {
				const entry = getSessionEntry(storePath, `agent:main:test-${i}`);
				expect(entry?.label).toBe(`Session ${i}`);
			}
		});
	});

	describe("delivery context normalization", () => {
		it("normalizes channel to lowercase", async () => {
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:test",
				patch: {
					lastChannel: "  TELEGRAM  ",
					lastTo: "  +1555123  ",
				},
			});

			const entry = getSessionEntry(storePath, "agent:main:test");
			expect(entry?.lastChannel).toBe("telegram");
			expect(entry?.lastTo).toBe("+1555123");
			expect(entry?.deliveryContext?.channel).toBe("telegram");
		});
	});

	describe("mergeSessionEntry edge cases", () => {
		it("uses current time when both timestamps are 0", () => {
			const before = Date.now();
			const result = mergeSessionEntry(
				{ sessionId: "a", updatedAt: 0 },
				{ updatedAt: 0 },
			);
			expect(result.updatedAt).toBeGreaterThanOrEqual(before);
		});

		it("preserves existing fields when patch is empty", () => {
			const existing: SessionEntry = {
				sessionId: "test",
				updatedAt: 1000,
				label: "Original",
				channel: "discord",
				totalTokens: 500,
			};
			const result = mergeSessionEntry(existing, {});
			expect(result.label).toBe("Original");
			expect(result.channel).toBe("discord");
			expect(result.totalTokens).toBe(500);
		});
	});

	describe("updateSessionStoreEntry", () => {
		it("returns null when entry does not exist", async () => {
			const result = await updateSessionStoreEntry({
				storePath,
				sessionKey: "agent:main:nonexistent",
				update: async () => ({ label: "Updated" }),
			});
			expect(result).toBeNull();
		});

		it("returns existing entry when update returns null", async () => {
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:test",
				patch: { label: "Original" },
			});

			const result = await updateSessionStoreEntry({
				storePath,
				sessionKey: "agent:main:test",
				update: async () => null,
			});

			expect(result?.label).toBe("Original");
		});
	});

	describe("provider migration", () => {
		it("migrates legacy provider field to channel", async () => {
			// Write legacy format directly
			await fs.promises.writeFile(
				storePath,
				JSON.stringify({
					"agent:main:test": {
						sessionId: "test-123",
						updatedAt: Date.now(),
						provider: "whatsapp",
						lastProvider: "telegram",
					},
				}),
				"utf-8",
			);

			clearSessionStoreCacheForTest();
			const store = loadSessionStore(storePath);
			const entry = store["agent:main:test"];

			expect(entry?.channel).toBe("whatsapp");
			expect(entry?.lastChannel).toBe("telegram");
			expect((entry as Record<string, unknown>).provider).toBeUndefined();
			expect((entry as Record<string, unknown>).lastProvider).toBeUndefined();
		});
	});
});

describe("session providers", () => {
	let tempDir: string;
	let storePath: string;

	// Mock runtime and state
	const mockRuntime = {} as IAgentRuntime;
	const mockState = {} as State;

	beforeEach(async () => {
		clearSessionStoreCacheForTest();
		tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), "eliza-session-provider-"),
		);
		storePath = path.join(tempDir, "sessions.json");
	});

	afterEach(async () => {
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	});

	describe("extractSessionContext", () => {
		it("returns null for empty memory", () => {
			const memory = { content: { text: "test" } } as Memory;
			const context = extractSessionContext(memory);
			expect(context).toBeNull();
		});

		it("extracts sessionId from memory root", () => {
			const memory = {
				content: { text: "test" },
				sessionId: "abc-123",
			} as unknown as Memory;
			const context = extractSessionContext(memory);
			expect(context?.sessionId).toBe("abc-123");
		});

		it("extracts session from metadata", () => {
			const memory = {
				content: { text: "test" },
				metadata: {
					sessionId: "meta-session",
					sessionKey: "agent:main:test",
				},
			} as unknown as Memory;
			const context = extractSessionContext(memory);
			expect(context?.sessionId).toBe("meta-session");
			expect(context?.sessionKey).toBe("agent:main:test");
		});

		it("extracts full session entry from metadata", () => {
			const sessionEntry: SessionEntry = {
				sessionId: "full-session",
				updatedAt: Date.now(),
				label: "Test Session",
			};
			const memory = {
				content: { text: "test" },
				metadata: {
					session: sessionEntry,
				},
			} as unknown as Memory;
			const context = extractSessionContext(memory);
			expect(context?.sessionId).toBe("full-session");
			expect(context?.entry?.label).toBe("Test Session");
		});
	});

	describe("createSessionProvider", () => {
		it("returns no session message when context empty", async () => {
			const provider = createSessionProvider();
			const memory = { content: { text: "test" } } as Memory;

			const result = await provider.get(mockRuntime, memory, mockState);

			expect(result.text).toBe("No session context available.");
			expect(result.data?.hasSession).toBe(false);
		});

		it("returns session info when context present", async () => {
			const provider = createSessionProvider();
			const memory = {
				content: { text: "test" },
				sessionId: "test-123",
				sessionKey: "agent:main:test",
			} as unknown as Memory;

			const result = await provider.get(mockRuntime, memory, mockState);

			expect(result.text).toContain("Session ID: test-123");
			expect(result.text).toContain("Session Key: agent:main:test");
			expect(result.values?.hasSession).toBe(true);
		});

		it("loads full entry from store when available", async () => {
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:provider-test",
				patch: {
					label: "Provider Test",
					chatType: "dm",
					channel: "telegram",
					sendPolicy: "deny",
				},
			});

			const provider = createSessionProvider({ storePath });
			const memory = {
				content: { text: "test" },
				sessionKey: "agent:main:provider-test",
			} as unknown as Memory;

			const result = await provider.get(mockRuntime, memory, mockState);

			expect(result.text).toContain("Label: Provider Test");
			expect(result.text).toContain("Chat Type: dm");
			expect(result.text).toContain("Channel: telegram");
			expect(result.text).toContain("SEND POLICY: DENY");
		});
	});

	describe("createSessionSkillsProvider", () => {
		it("returns no skills message when no session", async () => {
			const provider = createSessionSkillsProvider();
			const memory = { content: { text: "test" } } as Memory;

			const result = await provider.get(mockRuntime, memory, mockState);

			expect(result.text).toBe("No session skills available.");
			expect(result.data?.hasSkills).toBe(false);
		});

		it("returns no skills when session has none", async () => {
			const provider = createSessionSkillsProvider();
			const memory = {
				content: { text: "test" },
				metadata: {
					session: {
						sessionId: "test",
						updatedAt: Date.now(),
						skillsSnapshot: null,
					},
				},
			} as unknown as Memory;

			const result = await provider.get(mockRuntime, memory, mockState);

			expect(result.text).toBe("No skills configured for this session.");
		});

		it("returns skills list when present", async () => {
			const provider = createSessionSkillsProvider();
			const memory = {
				content: { text: "test" },
				metadata: {
					session: {
						sessionId: "test",
						updatedAt: Date.now(),
						skillsSnapshot: {
							prompt: "You have these skills...",
							skills: [{ name: "code-review" }, { name: "debugging" }],
						},
					},
				},
			} as unknown as Memory;

			const result = await provider.get(mockRuntime, memory, mockState);

			expect(result.text).toContain("Active Skills: code-review, debugging");
			expect(result.text).toContain("You have these skills...");
			expect(result.values?.skillCount).toBe(2);
		});
	});

	describe("createSendPolicyProvider", () => {
		it("returns allow policy when no session", async () => {
			const provider = createSendPolicyProvider();
			const memory = { content: { text: "test" } } as Memory;

			const result = await provider.get(mockRuntime, memory, mockState);

			expect(result.data?.sendPolicy).toBe("allow");
		});

		it("returns deny message when policy is deny", async () => {
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:deny-test",
				patch: { sendPolicy: "deny" },
			});

			const provider = createSendPolicyProvider({ storePath });
			const memory = {
				content: { text: "test" },
				sessionKey: "agent:main:deny-test",
			} as unknown as Memory;

			const result = await provider.get(mockRuntime, memory, mockState);

			expect(result.text).toContain("SEND POLICY: DENY");
			expect(result.text).toContain("Do NOT send messages");
			expect(result.values?.canSend).toBe(false);
		});

		it("returns allow policy when policy is allow", async () => {
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:allow-test",
				patch: { sendPolicy: "allow" },
			});

			const provider = createSendPolicyProvider({ storePath });
			const memory = {
				content: { text: "test" },
				sessionKey: "agent:main:allow-test",
			} as unknown as Memory;

			const result = await provider.get(mockRuntime, memory, mockState);

			expect(result.text).toBe("");
			expect(result.values?.canSend).toBe(true);
		});
	});

	describe("getSessionProviders", () => {
		it("returns array of three providers", () => {
			const providers = getSessionProviders();
			expect(providers.length).toBe(3);
			expect(providers.map((p) => p.name)).toEqual([
				"session",
				"sessionSkills",
				"sendPolicy",
			]);
		});
	});

	describe("SessionStateManager", () => {
		it("loads and caches store", async () => {
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:mgr-test",
				patch: { label: "Manager Test" },
			});

			const manager = new SessionStateManager(storePath);
			const store = manager.getStore();

			expect(store["agent:main:mgr-test"]?.label).toBe("Manager Test");
		});

		it("gets entry by key", async () => {
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:mgr-key",
				patch: { label: "By Key" },
			});

			const manager = new SessionStateManager(storePath);
			const entry = manager.getEntry("agent:main:mgr-key");

			expect(entry?.label).toBe("By Key");
		});

		it("gets entry by session ID", async () => {
			const result = await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:mgr-id",
				patch: { label: "By ID" },
			});

			const manager = new SessionStateManager(storePath);
			const entry = manager.getEntryById(result.sessionId);

			expect(entry?.label).toBe("By ID");
		});

		it("invalidates cache", async () => {
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:invalidate",
				patch: { label: "Original" },
			});

			const manager = new SessionStateManager(storePath, { cacheTtlMs: 60000 });

			// Load initial
			expect(manager.getEntry("agent:main:invalidate")?.label).toBe("Original");

			// Update externally
			await upsertSessionEntry({
				storePath,
				sessionKey: "agent:main:invalidate",
				patch: { label: "Updated" },
			});

			// Still cached
			expect(manager.getEntry("agent:main:invalidate")?.label).toBe("Original");

			// Invalidate
			manager.invalidate();

			// Now sees update
			expect(manager.getEntry("agent:main:invalidate")?.label).toBe("Updated");
		});
	});
});
