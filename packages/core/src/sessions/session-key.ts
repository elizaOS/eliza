/**
 * Session key utilities for elizaOS.
 *
 * Provides functions for building, parsing, and normalizing session keys
 * used to identify agent sessions, threads, and peer connections.
 *
 * Session keys follow the format: agent:{agentId}:{rest}
 *
 * @module sessions/session-key
 */

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";
export const DEFAULT_ACCOUNT_ID = "default";

// Pre-compiled regex
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

// ============================================================================
// Parsing Types
// ============================================================================

/**
 * Parsed agent session key components.
 */
export type ParsedAgentSessionKey = {
	/** The full original session key */
	raw: string;
	/** Agent ID extracted from the key */
	agentId: string;
	/** The remainder of the key after agent:{agentId}: */
	rest: string;
	/** Whether this is an ACP (Agent Communication Protocol) session */
	isAcp: boolean;
	/** Whether this is a subagent session */
	isSubagent: boolean;
	/** Thread ID if present */
	threadId?: string;
	/** Parent session key if this is a thread */
	parentKey?: string;
};

// ============================================================================
// Parsing Functions
// ============================================================================

/**
 * Parse an agent session key into its components.
 *
 * Session keys follow the format:
 * - agent:{agentId}:{rest}
 * - agent:{agentId}:acp:{...}
 * - agent:{agentId}:subagent:{subagentId}:{...}
 * - agent:{agentId}:{...}:thread:{threadId}
 *
 * @param sessionKey - The session key to parse
 * @returns Parsed components or null if invalid
 */
export function parseAgentSessionKey(
	sessionKey: string | undefined | null,
): ParsedAgentSessionKey | null {
	const raw = (sessionKey ?? "").trim().toLowerCase();
	if (!raw) {
		return null;
	}

	// Must start with "agent:"
	if (!raw.startsWith("agent:")) {
		return null;
	}

	const parts = raw.split(":");
	if (parts.length < 3) {
		return null;
	}

	const agentId = parts[1] ?? "";
	if (!agentId) {
		return null;
	}

	const rest = parts.slice(2).join(":");
	const isAcp = parts[2] === "acp";
	const isSubagent = parts[2] === "subagent";

	// Check for thread suffix
	const threadIndex = parts.indexOf("thread");
	let threadId: string | undefined;
	let parentKey: string | undefined;

	if (threadIndex !== -1 && threadIndex < parts.length - 1) {
		threadId = parts.slice(threadIndex + 1).join(":");
		parentKey = parts.slice(0, threadIndex).join(":");
	}

	return {
		raw,
		agentId,
		rest,
		isAcp,
		isSubagent,
		threadId,
		parentKey,
	};
}

/**
 * Check if a session key is an ACP session.
 *
 * @param sessionKey - The session key to check
 * @returns True if this is an ACP session
 */
export function isAcpSessionKey(
	sessionKey: string | undefined | null,
): boolean {
	const parsed = parseAgentSessionKey(sessionKey);
	return parsed?.isAcp ?? false;
}

/**
 * Check if a session key is a subagent session.
 *
 * @param sessionKey - The session key to check
 * @returns True if this is a subagent session
 */
export function isSubagentSessionKey(
	sessionKey: string | undefined | null,
): boolean {
	const parsed = parseAgentSessionKey(sessionKey);
	return parsed?.isSubagent ?? false;
}

/**
 * Resolve the parent session key for a thread session.
 *
 * @param sessionKey - The session key to resolve
 * @returns Parent session key or the original key if not a thread
 */
export function resolveThreadParentSessionKey(
	sessionKey: string | undefined | null,
): string | null {
	const parsed = parseAgentSessionKey(sessionKey);
	if (!parsed) {
		return null;
	}

	if (parsed.parentKey) {
		return parsed.parentKey;
	}

	return parsed.raw;
}

// ============================================================================
// Normalization Functions
// ============================================================================

function normalizeToken(value: string | undefined | null): string {
	return (value ?? "").trim().toLowerCase();
}

/**
 * Normalize a main key value.
 *
 * @param value - Value to normalize
 * @returns Normalized main key
 */
export function normalizeMainKey(value: string | undefined | null): string {
	const trimmed = (value ?? "").trim();
	return trimmed ? trimmed.toLowerCase() : DEFAULT_MAIN_KEY;
}

/**
 * Normalize an agent ID.
 *
 * Ensures the ID is path-safe and shell-friendly.
 *
 * @param value - Value to normalize
 * @returns Normalized agent ID
 */
export function normalizeAgentId(value: string | undefined | null): string {
	const rawTrimmed = (value ?? "").trim();
	if (!rawTrimmed) {
		return DEFAULT_AGENT_ID;
	}
	const trimmed =
		rawTrimmed.length > 1024 ? rawTrimmed.slice(0, 1024) : rawTrimmed;
	// Keep it path-safe + shell-friendly.
	if (VALID_ID_RE.test(trimmed)) {
		return trimmed.toLowerCase();
	}
	// Best-effort fallback: collapse invalid characters to "-"
	return (
		trimmed
			.toLowerCase()
			.replace(INVALID_CHARS_RE, "-")
			.replace(LEADING_DASH_RE, "")
			.replace(TRAILING_DASH_RE, "")
			.slice(0, 64) || DEFAULT_AGENT_ID
	);
}

/**
 * Sanitize an agent ID (alias for normalizeAgentId).
 *
 * @param value - Value to sanitize
 * @returns Sanitized agent ID
 */
export function sanitizeAgentId(value: string | undefined | null): string {
	return normalizeAgentId(value);
}

/**
 * Normalize an account ID.
 *
 * @param value - Value to normalize
 * @returns Normalized account ID
 */
export function normalizeAccountId(value: string | undefined | null): string {
	const rawTrimmed = (value ?? "").trim();
	if (!rawTrimmed) {
		return DEFAULT_ACCOUNT_ID;
	}
	const trimmed =
		rawTrimmed.length > 1024 ? rawTrimmed.slice(0, 1024) : rawTrimmed;
	if (VALID_ID_RE.test(trimmed)) {
		return trimmed.toLowerCase();
	}
	return (
		trimmed
			.toLowerCase()
			.replace(INVALID_CHARS_RE, "-")
			.replace(LEADING_DASH_RE, "")
			.replace(TRAILING_DASH_RE, "")
			.slice(0, 64) || DEFAULT_ACCOUNT_ID
	);
}

// ============================================================================
// Building Functions
// ============================================================================

/**
 * Build an agent session key from components.
 *
 * @param agentId - The agent ID
 * @param rest - The rest of the key
 * @returns Formatted session key
 */
export function buildAgentSessionKey(agentId: string, rest: string): string {
	const normalizedAgentId = agentId.trim().toLowerCase();
	const normalizedRest = rest.trim().toLowerCase();
	return `agent:${normalizedAgentId}:${normalizedRest}`;
}

/**
 * Build the main session key for an agent.
 *
 * @param params - Session key parameters
 * @returns Main session key
 */
export function buildAgentMainSessionKey(params: {
	agentId: string;
	mainKey?: string | undefined;
}): string {
	const agentId = normalizeAgentId(params.agentId);
	const mainKey = normalizeMainKey(params.mainKey);
	return `agent:${agentId}:${mainKey}`;
}

/**
 * Build an ACP session key.
 *
 * @param agentId - The agent ID
 * @param acpKey - The ACP-specific key portion
 * @returns Formatted ACP session key
 */
export function buildAcpSessionKey(agentId: string, acpKey: string): string {
	return buildAgentSessionKey(agentId, `acp:${acpKey}`);
}

/**
 * Build a subagent session key.
 *
 * @param agentId - The parent agent ID
 * @param subagentId - The subagent ID
 * @param rest - Additional key portion
 * @returns Formatted subagent session key
 */
export function buildSubagentSessionKey(
	agentId: string,
	subagentId: string,
	rest?: string,
): string {
	const normalizedSubagent = subagentId.trim().toLowerCase();
	const suffix = rest ? `:${rest.trim().toLowerCase()}` : "";
	return buildAgentSessionKey(
		agentId,
		`subagent:${normalizedSubagent}${suffix}`,
	);
}

/**
 * Build a peer session key for an agent.
 *
 * @param params - Peer session parameters
 * @returns Peer session key
 */
export function buildAgentPeerSessionKey(params: {
	agentId: string;
	mainKey?: string | undefined;
	channel: string;
	accountId?: string | null;
	peerKind?: "dm" | "group" | "channel" | null;
	peerId?: string | null;
	identityLinks?: Record<string, string[]>;
	/** DM session scope. */
	dmScope?:
		| "main"
		| "per-peer"
		| "per-channel-peer"
		| "per-account-channel-peer";
}): string {
	const peerKind = params.peerKind ?? "dm";
	if (peerKind === "dm") {
		const dmScope = params.dmScope ?? "main";
		let peerId = (params.peerId ?? "").trim();
		const linkedPeerId =
			dmScope === "main"
				? null
				: resolveLinkedPeerId({
						identityLinks: params.identityLinks,
						channel: params.channel,
						peerId,
					});
		if (linkedPeerId) {
			peerId = linkedPeerId;
		}
		peerId = peerId.toLowerCase();
		if (dmScope === "per-account-channel-peer" && peerId) {
			const channel = (params.channel ?? "").trim().toLowerCase() || "unknown";
			const accountId = normalizeAccountId(params.accountId);
			return `agent:${normalizeAgentId(params.agentId)}:${channel}:${accountId}:dm:${peerId}`;
		}
		if (dmScope === "per-channel-peer" && peerId) {
			const channel = (params.channel ?? "").trim().toLowerCase() || "unknown";
			return `agent:${normalizeAgentId(params.agentId)}:${channel}:dm:${peerId}`;
		}
		if (dmScope === "per-peer" && peerId) {
			return `agent:${normalizeAgentId(params.agentId)}:dm:${peerId}`;
		}
		return buildAgentMainSessionKey({
			agentId: params.agentId,
			mainKey: params.mainKey,
		});
	}
	const channel = (params.channel ?? "").trim().toLowerCase() || "unknown";
	const peerId = ((params.peerId ?? "").trim() || "unknown").toLowerCase();
	return `agent:${normalizeAgentId(params.agentId)}:${channel}:${peerKind}:${peerId}`;
}

function resolveLinkedPeerId(params: {
	identityLinks?: Record<string, string[]>;
	channel: string;
	peerId: string;
}): string | null {
	const identityLinks = params.identityLinks;
	if (!identityLinks) {
		return null;
	}
	const peerId = params.peerId.trim();
	if (!peerId) {
		return null;
	}
	const candidates = new Set<string>();
	const rawCandidate = normalizeToken(peerId);
	if (rawCandidate) {
		candidates.add(rawCandidate);
	}
	const channel = normalizeToken(params.channel);
	if (channel) {
		const scopedCandidate = normalizeToken(`${channel}:${peerId}`);
		if (scopedCandidate) {
			candidates.add(scopedCandidate);
		}
	}
	if (candidates.size === 0) {
		return null;
	}
	for (const [canonical, ids] of Object.entries(identityLinks)) {
		const canonicalName = canonical.trim();
		if (!canonicalName) {
			continue;
		}
		if (!Array.isArray(ids)) {
			continue;
		}
		for (const id of ids) {
			const normalized = normalizeToken(id);
			if (normalized && candidates.has(normalized)) {
				return canonicalName;
			}
		}
	}
	return null;
}

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * Convert a store session key to a request session key.
 *
 * @param storeKey - Store session key
 * @returns Request session key or undefined
 */
export function toAgentRequestSessionKey(
	storeKey: string | undefined | null,
): string | undefined {
	const raw = (storeKey ?? "").trim();
	if (!raw) {
		return undefined;
	}
	return parseAgentSessionKey(raw)?.rest ?? raw;
}

/**
 * Convert a request session key to a store session key.
 *
 * @param params - Conversion parameters
 * @returns Store session key
 */
export function toAgentStoreSessionKey(params: {
	agentId: string;
	requestKey: string | undefined | null;
	mainKey?: string | undefined;
}): string {
	const raw = (params.requestKey ?? "").trim();
	if (!raw || raw === DEFAULT_MAIN_KEY) {
		return buildAgentMainSessionKey({
			agentId: params.agentId,
			mainKey: params.mainKey,
		});
	}
	const lowered = raw.toLowerCase();
	if (lowered.startsWith("agent:")) {
		return lowered;
	}
	if (lowered.startsWith("subagent:")) {
		return `agent:${normalizeAgentId(params.agentId)}:${lowered}`;
	}
	return `agent:${normalizeAgentId(params.agentId)}:${lowered}`;
}

/**
 * Resolve the agent ID from a session key.
 *
 * @param sessionKey - Session key to parse
 * @returns Resolved agent ID
 */
export function resolveAgentIdFromSessionKey(
	sessionKey: string | undefined | null,
): string {
	const parsed = parseAgentSessionKey(sessionKey);
	return normalizeAgentId(parsed?.agentId ?? DEFAULT_AGENT_ID);
}

// ============================================================================
// Group/Thread Keys
// ============================================================================

/**
 * Build a group history key.
 *
 * @param params - History key parameters
 * @returns Group history key
 */
export function buildGroupHistoryKey(params: {
	channel: string;
	accountId?: string | null;
	peerKind: "group" | "channel";
	peerId: string;
}): string {
	const channel = normalizeToken(params.channel) || "unknown";
	const accountId = normalizeAccountId(params.accountId);
	const peerId = params.peerId.trim().toLowerCase() || "unknown";
	return `${channel}:${accountId}:${params.peerKind}:${peerId}`;
}

/**
 * Resolve thread session keys.
 *
 * @param params - Thread resolution parameters
 * @returns Session key and optional parent session key
 */
export function resolveThreadSessionKeys(params: {
	baseSessionKey: string;
	threadId?: string | null;
	parentSessionKey?: string;
	useSuffix?: boolean;
}): { sessionKey: string; parentSessionKey?: string } {
	const threadId = (params.threadId ?? "").trim();
	if (!threadId) {
		return { sessionKey: params.baseSessionKey, parentSessionKey: undefined };
	}
	const normalizedThreadId = threadId.toLowerCase();
	const useSuffix = params.useSuffix ?? true;
	const sessionKey = useSuffix
		? `${params.baseSessionKey}:thread:${normalizedThreadId}`
		: params.baseSessionKey;
	return { sessionKey, parentSessionKey: params.parentSessionKey };
}
