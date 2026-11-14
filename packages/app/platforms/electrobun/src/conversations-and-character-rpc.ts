/**
 * Pure composition layer for `listConversations` and `getCharacter`.
 *
 * Same failure semantics as the auth/config composers (see
 * config-and-auth-rpc.ts header): throws `AgentNotReadyError` rather
 * than fabricating empty placeholders. Returning `{ conversations: [] }`
 * as a "not ready" placeholder would let the renderer authoritatively
 * render an empty sidebar before the agent's real list landed —
 * worst case the user clicks "New Chat" and overwrites real history.
 *
 * Read-only surface only — write operations (createConversation,
 * updateConversation, deleteConversation) stay on the existing HTTP
 * paths until we design typed-RPC write semantics with idempotency
 * and conflict resolution.
 */

import { AgentNotReadyError } from "./config-and-auth-rpc";
import type {
	CharacterSnapshot,
	ConversationMessagesSnapshot,
	ConversationsListSnapshot,
} from "./rpc-schema";

const DEFAULT_TIMEOUT_MS = 4_000;

async function fetchJson<T>(port: number, pathname: string): Promise<T | null> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
			method: "GET",
			signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

// ── listConversations ──────────────────────────────────────────────

export type ConversationsListReader = (
	port: number,
) => Promise<ConversationsListSnapshot | null>;

export const readConversationsListViaHttp: ConversationsListReader = async (
	port,
) => {
	const raw = await fetchJson<Record<string, unknown>>(
		port,
		"/api/conversations",
	);
	if (!raw) return null;
	const list = raw.conversations;
	if (!Array.isArray(list)) return null;
	return {
		conversations: list.filter(
			(item): item is Record<string, unknown> =>
				typeof item === "object" && item !== null,
		),
	};
};

export async function composeConversationsListSnapshot(
	port: number | null,
	read: ConversationsListReader,
): Promise<ConversationsListSnapshot> {
	if (port === null) throw new AgentNotReadyError("listConversations");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("listConversations");
	return value;
}

// ── getConversationMessages ────────────────────────────────────────

export type ConversationMessagesReader = (
	port: number,
	id: string,
) => Promise<ConversationMessagesSnapshot | null>;

export const readConversationMessagesViaHttp: ConversationMessagesReader =
	async (port, id) => {
		const raw = await fetchJson<Record<string, unknown>>(
			port,
			`/api/conversations/${encodeURIComponent(id)}/messages`,
		);
		if (!raw) return null;
		const list = raw.messages;
		if (!Array.isArray(list)) return null;
		return {
			messages: list.filter(
				(item): item is Record<string, unknown> =>
					typeof item === "object" && item !== null,
			),
		};
	};

export async function composeConversationMessagesSnapshot(
	port: number | null,
	id: string,
	read: ConversationMessagesReader,
): Promise<ConversationMessagesSnapshot> {
	if (port === null) throw new AgentNotReadyError("getConversationMessages");
	if (id.trim().length === 0) throw new Error("Conversation id is required.");
	const value = await read(port, id);
	if (value === null) {
		throw new AgentNotReadyError("getConversationMessages");
	}
	return value;
}

// ── getCharacter ───────────────────────────────────────────────────

export type CharacterReader = (
	port: number,
) => Promise<CharacterSnapshot | null>;

export const readCharacterViaHttp: CharacterReader = async (port) => {
	const raw = await fetchJson<Record<string, unknown>>(port, "/api/character");
	if (!raw) return null;
	return raw;
};

export async function composeCharacterSnapshot(
	port: number | null,
	read: CharacterReader,
): Promise<CharacterSnapshot> {
	if (port === null) throw new AgentNotReadyError("getCharacter");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getCharacter");
	return value;
}
