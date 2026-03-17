/**
 * Session path utilities for elizaOS.
 *
 * Provides functions for resolving session-related file paths including
 * session stores, transcripts, and agent-specific directories.
 *
 * @module sessions/paths
 */

import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "./session-key.js";
import type { SessionEntry } from "./types.js";

// ============================================================================
// State Directory
// ============================================================================

/**
 * Resolve the Eliza state directory.
 *
 * Uses ELIZA_STATE_DIR env var, falling back to ~/.eliza
 *
 * @param env - Environment variables (defaults to process.env)
 * @param homedir - Homedir function (defaults to os.homedir)
 * @returns Absolute path to state directory
 */
export function resolveStateDir(
	env: NodeJS.ProcessEnv = process.env,
	homedir: () => string = os.homedir,
): string {
	const envDir = env.ELIZA_STATE_DIR?.trim();
	if (envDir) {
		if (envDir.startsWith("~")) {
			return path.resolve(envDir.replace(/^~(?=$|[\\/])/, homedir()));
		}
		return path.resolve(envDir);
	}
	return path.join(homedir(), ".eliza");
}

// ============================================================================
// Agent Sessions Directory
// ============================================================================

/**
 * Resolve the sessions directory for an agent.
 *
 * @param agentId - Agent identifier (defaults to "main")
 * @param env - Environment variables
 * @param homedir - Homedir function
 * @returns Absolute path to agent sessions directory
 */
export function resolveAgentSessionsDir(
	agentId?: string,
	env: NodeJS.ProcessEnv = process.env,
	homedir: () => string = os.homedir,
): string {
	const root = resolveStateDir(env, homedir);
	const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
	return path.join(root, "agents", id, "sessions");
}

/**
 * Resolve the transcripts directory for the default agent.
 *
 * @param env - Environment variables
 * @param homedir - Homedir function
 * @returns Absolute path to transcripts directory
 */
export function resolveSessionTranscriptsDir(
	env: NodeJS.ProcessEnv = process.env,
	homedir: () => string = os.homedir,
): string {
	return resolveAgentSessionsDir(DEFAULT_AGENT_ID, env, homedir);
}

/**
 * Resolve the transcripts directory for a specific agent.
 *
 * @param agentId - Agent identifier
 * @param env - Environment variables
 * @param homedir - Homedir function
 * @returns Absolute path to agent transcripts directory
 */
export function resolveSessionTranscriptsDirForAgent(
	agentId?: string,
	env: NodeJS.ProcessEnv = process.env,
	homedir: () => string = os.homedir,
): string {
	return resolveAgentSessionsDir(agentId, env, homedir);
}

// ============================================================================
// Session Store Path
// ============================================================================

/**
 * Resolve the default session store path for an agent.
 *
 * @param agentId - Agent identifier (defaults to "main")
 * @returns Absolute path to sessions.json
 */
export function resolveDefaultSessionStorePath(agentId?: string): string {
	return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}

/**
 * Resolve a session store path with optional template expansion.
 *
 * Supports:
 * - `{agentId}` placeholder in path
 * - `~` expansion for home directory
 * - Defaults to standard sessions.json location
 *
 * @param store - Custom store path (optional)
 * @param opts - Options including agentId
 * @returns Resolved absolute path
 */
export function resolveStorePath(
	store?: string,
	opts?: { agentId?: string },
): string {
	const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);

	if (!store) {
		return resolveDefaultSessionStorePath(agentId);
	}

	let resolved = store;

	// Expand {agentId} placeholder
	if (resolved.includes("{agentId}")) {
		resolved = resolved.split("{agentId}").join(agentId);
	}

	// Expand ~ to home directory
	if (resolved.startsWith("~")) {
		resolved = resolved.replace(/^~(?=$|[\\/])/, os.homedir());
	}

	return path.resolve(resolved);
}

// ============================================================================
// Session Transcript Path
// ============================================================================

/**
 * Resolve the path to a session transcript file.
 *
 * @param sessionId - Session identifier
 * @param agentId - Agent identifier (defaults to "main")
 * @param topicId - Optional topic ID for topic-specific transcripts
 * @returns Absolute path to transcript .jsonl file
 */
export function resolveSessionTranscriptPath(
	sessionId: string,
	agentId?: string,
	topicId?: string | number,
): string {
	const safeTopicId =
		typeof topicId === "string"
			? encodeURIComponent(topicId)
			: typeof topicId === "number"
				? String(topicId)
				: undefined;

	const fileName =
		safeTopicId !== undefined
			? `${sessionId}-topic-${safeTopicId}.jsonl`
			: `${sessionId}.jsonl`;

	return path.join(resolveAgentSessionsDir(agentId), fileName);
}

/**
 * Resolve the path to a session file.
 *
 * Uses the entry's sessionFile if set, otherwise falls back to
 * the default transcript path.
 *
 * @param sessionId - Session identifier
 * @param entry - Optional session entry with sessionFile
 * @param opts - Options including agentId
 * @returns Absolute path to session file
 */
export function resolveSessionFilePath(
	sessionId: string,
	entry?: SessionEntry,
	opts?: { agentId?: string },
): string {
	const candidate = entry?.sessionFile?.trim();
	return candidate
		? candidate
		: resolveSessionTranscriptPath(sessionId, opts?.agentId);
}

// ============================================================================
// Path Validation
// ============================================================================

/**
 * Check if a path is within the Eliza state directory.
 *
 * @param filePath - Path to check
 * @returns True if path is within state directory
 */
export function isWithinStateDir(filePath: string): boolean {
	const stateDir = resolveStateDir();
	const resolved = path.resolve(filePath);
	return resolved.startsWith(stateDir + path.sep) || resolved === stateDir;
}

/**
 * Ensure a path is safe to use for session storage.
 *
 * @param filePath - Path to validate
 * @returns Resolved path if safe
 * @throws Error if path is outside state directory
 */
export function ensureSafeSessionPath(filePath: string): string {
	const resolved = path.resolve(filePath);

	// Allow paths within state directory
	if (isWithinStateDir(resolved)) {
		return resolved;
	}

	// Allow absolute paths if explicitly configured
	if (process.env.ELIZA_ALLOW_EXTERNAL_SESSION_PATHS === "true") {
		return resolved;
	}

	throw new Error(
		`Session path "${filePath}" is outside the state directory. ` +
			`Set ELIZA_ALLOW_EXTERNAL_SESSION_PATHS=true to allow external paths.`,
	);
}
