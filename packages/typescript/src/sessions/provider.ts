/**
 * Session provider for elizaOS runtime.
 *
 * Exposes session context to agents during message processing.
 *
 * @module sessions/provider
 */

import type { Provider, ProviderResult } from "../types/components.js";
import type { Memory, MemoryMetadata } from "../types/memory.js";
import type { IAgentRuntime } from "../types/runtime.js";
import type { State } from "../types/state.js";
import { getSessionEntry, loadSessionStore } from "./store.js";
import type { SessionEntry, SessionStore } from "./types.js";

// ============================================================================
// Session Context Extraction
// ============================================================================

/**
 * Extract session context from a memory object.
 *
 * Looks for session information in:
 * 1. memory.sessionId / memory.sessionKey
 * 2. memory.metadata.session
 * 3. memory.metadata.sessionId / memory.metadata.sessionKey
 *
 * @param memory - Memory to extract session from
 * @returns Session context or null
 */
export function extractSessionContext(memory: Memory): {
	sessionId?: string;
	sessionKey?: string;
	entry?: SessionEntry;
} | null {
	// Direct properties on memory (for backwards compat — runtime may attach extra fields)
	const memoryRecord = memory as Memory & Record<string, unknown>;
	const directSessionId = memoryRecord.sessionId as string | undefined;
	const directSessionKey = memoryRecord.sessionKey as string | undefined;

	// Metadata-based session info
	const metadata = memory.metadata as
		| (MemoryMetadata & Record<string, unknown>)
		| undefined;
	const metaSessionId = metadata?.sessionId as string | undefined;
	const metaSessionKey = metadata?.sessionKey as string | undefined;
	const metaSession = metadata?.session as SessionEntry | undefined;

	const sessionId = directSessionId ?? metaSessionId ?? metaSession?.sessionId;
	const sessionKey = directSessionKey ?? metaSessionKey;

	if (!sessionId && !sessionKey) {
		return null;
	}

	return {
		sessionId,
		sessionKey,
		entry: metaSession,
	};
}

// ============================================================================
// Session Provider
// ============================================================================

/**
 * Create a session provider that exposes session context.
 *
 * @param options - Provider options
 * @returns Provider instance
 */
export function createSessionProvider(options?: {
	/** Path to session store (defaults to runtime's configured store) */
	storePath?: string;
	/** Custom name for the provider */
	name?: string;
}): Provider {
	return {
		name: options?.name ?? "session",
		description: "Current session context and state",
		dynamic: true,

		async get(
			_runtime: IAgentRuntime,
			message: Memory,
			_state: State,
		): Promise<ProviderResult> {
			const context = extractSessionContext(message);
			if (!context) {
				return {
					text: "No session context available.",
					data: { hasSession: false },
				};
			}

			// Try to get full session entry
			let entry = context.entry;
			if (!entry && context.sessionKey && options?.storePath) {
				entry = getSessionEntry(options.storePath, context.sessionKey);
			}

			// Build text representation
			const lines: string[] = [];
			lines.push(`Session ID: ${context.sessionId ?? "unknown"}`);

			if (context.sessionKey) {
				lines.push(`Session Key: ${context.sessionKey}`);
			}

			if (entry) {
				if (entry.label) {
					lines.push(`Label: ${entry.label}`);
				}
				if (entry.chatType) {
					lines.push(`Chat Type: ${entry.chatType}`);
				}
				if (entry.channel) {
					lines.push(`Channel: ${entry.channel}`);
				}
				if (entry.modelOverride) {
					lines.push(`Model Override: ${entry.modelOverride}`);
				}
				if (entry.thinkingLevel) {
					lines.push(`Thinking Level: ${entry.thinkingLevel}`);
				}
				if (entry.sendPolicy === "deny") {
					lines.push("");
					lines.push("⚠️ SEND POLICY: DENY - Do not send messages externally.");
				}
				if (entry.totalTokens) {
					lines.push(`Total Tokens Used: ${entry.totalTokens}`);
				}
			}

			return {
				text: lines.join("\n"),
				values: {
					sessionId: context.sessionId,
					sessionKey: context.sessionKey,
					hasSession: true,
				},
				data: {
					hasSession: true,
					sessionId: context.sessionId,
					sessionKey: context.sessionKey,
					entry: entry as SessionEntry & Record<string, unknown>,
				},
			};
		},
	};
}

// ============================================================================
// Session Skills Provider
// ============================================================================

/**
 * Create a provider that exposes session skills.
 *
 * @param options - Provider options
 * @returns Provider instance
 */
export function createSessionSkillsProvider(options?: {
	storePath?: string;
	name?: string;
}): Provider {
	return {
		name: options?.name ?? "sessionSkills",
		description: "Skills active in the current session",
		dynamic: true,

		async get(
			_runtime: IAgentRuntime,
			message: Memory,
			_state: State,
		): Promise<ProviderResult> {
			const context = extractSessionContext(message);
			if (!context) {
				return {
					text: "No session skills available.",
					data: { hasSkills: false },
				};
			}

			let entry = context.entry;
			if (!entry && context.sessionKey && options?.storePath) {
				entry = getSessionEntry(options.storePath, context.sessionKey);
			}

			const snapshot = entry?.skillsSnapshot;
			if (!snapshot || !snapshot.skills.length) {
				return {
					text: "No skills configured for this session.",
					data: { hasSkills: false, skills: [] },
				};
			}

			const skillNames = snapshot.skills.map((s: { name: string }) => s.name);
			const lines = [
				`Active Skills: ${skillNames.join(", ")}`,
				"",
				snapshot.prompt,
			];

			return {
				text: lines.join("\n"),
				values: {
					skillCount: skillNames.length,
					skillNames,
				},
				data: {
					hasSkills: true,
					skills: snapshot.skills,
					prompt: snapshot.prompt,
				},
			};
		},
	};
}

// ============================================================================
// Send Policy Provider
// ============================================================================

/**
 * Create a provider that enforces session send policy.
 *
 * When sendPolicy is "deny", adds strong guidance to prevent
 * the agent from sending external messages.
 *
 * @param options - Provider options
 * @returns Provider instance
 */
export function createSendPolicyProvider(options?: {
	storePath?: string;
	name?: string;
}): Provider {
	return {
		name: options?.name ?? "sendPolicy",
		description: "Session send policy enforcement",
		dynamic: true,
		// High position to appear prominently in context
		position: 100,

		async get(
			_runtime: IAgentRuntime,
			message: Memory,
			_state: State,
		): Promise<ProviderResult> {
			const context = extractSessionContext(message);
			if (!context) {
				return {
					text: "",
					data: { sendPolicy: "allow" },
				};
			}

			let entry = context.entry;
			if (!entry && context.sessionKey && options?.storePath) {
				entry = getSessionEntry(options.storePath, context.sessionKey);
			}

			const sendPolicy = entry?.sendPolicy ?? "allow";

			if (sendPolicy === "deny") {
				return {
					text: [
						"🚫 SEND POLICY: DENY",
						"",
						"This session has sending DISABLED.",
						"Do NOT send messages to external channels.",
						"Do NOT use send/reply actions.",
						"You may still process and respond internally.",
					].join("\n"),
					values: {
						sendPolicy: "deny",
						canSend: false,
					},
					data: {
						sendPolicy: "deny",
						canSend: false,
					},
				};
			}

			return {
				text: "",
				values: {
					sendPolicy: "allow",
					canSend: true,
				},
				data: {
					sendPolicy: "allow",
					canSend: true,
				},
			};
		},
	};
}

// ============================================================================
// Default Session Providers
// ============================================================================

/**
 * Get all default session providers.
 *
 * @param options - Provider options
 * @returns Array of session providers
 */
export function getSessionProviders(options?: {
	storePath?: string;
}): Provider[] {
	return [
		createSessionProvider(options),
		createSessionSkillsProvider(options),
		createSendPolicyProvider(options),
	];
}

// ============================================================================
// Session State Manager
// ============================================================================

/**
 * Session state manager for runtime integration.
 *
 * Provides methods to access and update session state
 * during message processing.
 */
export class SessionStateManager {
	private store: SessionStore | null = null;
	private lastLoadTime = 0;
	private readonly cacheTtlMs: number;

	constructor(
		private readonly storePath: string,
		options?: { cacheTtlMs?: number },
	) {
		this.cacheTtlMs = options?.cacheTtlMs ?? 5000;
	}

	/**
	 * Get the session store, loading if necessary.
	 */
	getStore(): SessionStore {
		const now = Date.now();
		if (!this.store || now - this.lastLoadTime > this.cacheTtlMs) {
			this.store = loadSessionStore(this.storePath);
			this.lastLoadTime = now;
		}
		return this.store;
	}

	/**
	 * Get a session entry by key.
	 */
	getEntry(sessionKey: string): SessionEntry | undefined {
		return this.getStore()[sessionKey];
	}

	/**
	 * Get a session entry by ID.
	 */
	getEntryById(sessionId: string): SessionEntry | undefined {
		const store = this.getStore();
		return Object.values(store).find((e) => e?.sessionId === sessionId);
	}

	/**
	 * Invalidate the cached store.
	 */
	invalidate(): void {
		this.store = null;
		this.lastLoadTime = 0;
	}
}
