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
import type { SessionEntry } from "./types.js";

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
		contexts: ["general", "messaging"],
		contextGate: { anyOf: ["general", "messaging"] },
		cacheStable: false,
		cacheScope: "turn",
		roleGate: { minRole: "USER" },

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

			// Use session entry directly from context
			const entry = context.entry;

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
		contexts: ["general", "agent_internal"],
		contextGate: { anyOf: ["general", "agent_internal"] },
		cacheStable: false,
		cacheScope: "turn",
		roleGate: { minRole: "USER" },

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

			const entry = context.entry;

			const snapshot = entry?.skillsSnapshot;
			if (!snapshot?.skills.length) {
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
		contexts: ["general", "messaging"],
		contextGate: { anyOf: ["general", "messaging"] },
		cacheStable: false,
		cacheScope: "turn",
		roleGate: { minRole: "USER" },

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

			const entry = context.entry;

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
