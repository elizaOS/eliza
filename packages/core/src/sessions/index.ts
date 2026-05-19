/**
 * Session management utilities for elizaOS.
 *
 * Provides:
 * - Session key building and parsing
 * - Session types and data structures
 * - Session storage with caching and locking
 * - Session path resolution
 * - Agent/peer/thread session management
 * - Identity linking for cross-platform users
 *
 * @module sessions
 */

// ============================================================================
// Session Key Utilities
// ============================================================================

export {
	buildAcpSessionKey,
	buildAgentMainSessionKey,
	buildAgentPeerSessionKey,
	buildAgentSessionKey,
	buildGroupHistoryKey,
	buildSubagentSessionKey,
	DEFAULT_ACCOUNT_ID,
	DEFAULT_AGENT_ID,
	DEFAULT_MAIN_KEY,
	isAcpSessionKey,
	isSubagentSessionKey,
	normalizeAccountId,
	normalizeAgentId,
	normalizeMainKey,
	type ParsedAgentSessionKey,
	parseAgentSessionKey,
	resolveAgentIdFromSessionKey,
	resolveThreadParentSessionKey,
	resolveThreadSessionKeys,
	sanitizeAgentId,
	toAgentRequestSessionKey,
	toAgentStoreSessionKey,
} from "./session-key.js";

// ============================================================================
// Session Types
// ============================================================================

// Note: SessionOrigin, SessionModelOverride, SessionUsage, SessionSkillEntry,
// SessionSkillsSnapshot, and SessionScope are defined in types/memory.ts and
// types/channel-config.ts to avoid circular dependencies. They are exported
// from the main types module, not from sessions.

export {
	createSessionEntry,
	DEFAULT_IDLE_MINUTES,
	DEFAULT_RESET_TRIGGER,
	DEFAULT_RESET_TRIGGERS,
	type GroupKeyResolution,
	isValidSessionEntry,
	mergeSessionEntry,
	type SessionChatType,
	type SessionDeliveryContext,
	type SessionEntry,
	type SessionResolution,
	type SessionStore,
} from "./types.js";

// ============================================================================
// Session Providers
// ============================================================================

export {
	createSendPolicyProvider,
	createSessionProvider,
	createSessionSkillsProvider,
	extractSessionContext,
	getSessionProviders,
} from "./provider.js";
